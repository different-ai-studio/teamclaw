use crate::proto::teamclaw::{rpc_response, RpcRequest, RpcResponse};
use prost::Message as ProstMessage;
use std::collections::HashMap;
use std::sync::Arc;
use teamclaw_transport::{DeliveryGuarantee, MessagePublisher};
use tokio::sync::oneshot;
use uuid::Uuid;

/// Server-side RPC handler: receives requests and sends responses.
#[allow(dead_code)]
pub struct RpcServer {
    pub client: Arc<dyn MessagePublisher>,
    pub team_id: String,
    pub actor_id: String,
}

impl RpcServer {
    pub fn new(client: Arc<dyn MessagePublisher>, team_id: String, actor_id: String) -> Self {
        Self {
            client,
            team_id,
            actor_id,
        }
    }

    /// Parses an MQTT topic and payload into a (request_id, RpcRequest) pair.
    ///
    /// Expected topic format: `amux/{teamId}/{targetActorId}/rpc/req`
    #[allow(dead_code)]
    pub fn parse_request(topic: &str, payload: &[u8]) -> Option<(String, RpcRequest)> {
        let parts: Vec<&str> = topic.split('/').collect();
        // amux / {teamId} / {targetActorId} / rpc / req
        if parts.len() != 5 {
            return None;
        }
        if parts[0] != "amux" || parts[3] != "rpc" || parts[4] != "req" {
            return None;
        }
        let request = RpcRequest::decode(payload).ok()?;
        if request.request_id.is_empty() {
            return None;
        }
        Some((request.request_id.clone(), request))
    }

    /// Publishes an RPC response back to the requester's actor namespace.
    ///
    /// Response topic: `amux/{teamId}/{requesterActorId}/rpc/res`
    #[allow(dead_code)]
    pub async fn respond(&self, request: &RpcRequest, response: RpcResponse) {
        let topic = format!(
            "amux/{}/{}/rpc/res",
            self.team_id, request.requester_actor_id
        );
        let payload = response.encode_to_vec();
        if let Err(e) = self
            .client
            .publish(&topic, payload, false, DeliveryGuarantee::AtLeastOnce)
            .await
        {
            tracing::warn!("RpcServer: failed to publish response: {e}");
        }
    }
}

/// Client-side RPC handler: sends requests and waits for responses via oneshot channels.
#[allow(dead_code)]
pub struct RpcClient {
    pub client: Arc<dyn MessagePublisher>,
    pub team_id: String,
    pub actor_id: String,
    pub pending: HashMap<String, oneshot::Sender<RpcResponse>>,
    /// Remote-tool invoke: wait for the first capable client; ignore unsupported_platform.
    pub remote_tool_pending: HashMap<String, oneshot::Sender<RpcResponse>>,
}

#[allow(dead_code)]
impl RpcClient {
    pub fn new(client: Arc<dyn MessagePublisher>, team_id: String, actor_id: String) -> Self {
        Self {
            client,
            team_id,
            actor_id,
            pending: HashMap::new(),
            remote_tool_pending: HashMap::new(),
        }
    }

    pub fn set_publisher(&mut self, client: Arc<dyn MessagePublisher>) {
        self.client = client;
    }

    /// Sends an RPC request to `target_actor_id` and returns the request id plus
    /// a receiver for the response.
    pub async fn request(
        &mut self,
        target_actor_id: &str,
        mut request: RpcRequest,
    ) -> crate::error::Result<(String, oneshot::Receiver<RpcResponse>)> {
        let request_id = Self::new_request_id();
        request.request_id = request_id.clone();
        let topic = format!("amux/{}/{}/rpc/req", self.team_id, target_actor_id);
        let payload = request.encode_to_vec();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(request_id.clone(), tx);
        self.client
            .publish(&topic, payload, false, DeliveryGuarantee::AtLeastOnce)
            .await?;
        Ok((request_id, rx))
    }

    /// Remote-tool fan-out: publish to a member actor topic and wait for the first
    /// capable client. Clients that cannot execute the tool should not reply.
    pub async fn request_remote_tool(
        &mut self,
        target_actor_id: &str,
        mut request: RpcRequest,
    ) -> crate::error::Result<(String, oneshot::Receiver<RpcResponse>)> {
        let request_id = Self::new_request_id();
        request.request_id = request_id.clone();
        let topic = format!("amux/{}/{}/rpc/req", self.team_id, target_actor_id);
        let payload = request.encode_to_vec();
        let (tx, rx) = oneshot::channel();
        self.remote_tool_pending.insert(request_id.clone(), tx);
        self.client
            .publish(&topic, payload, false, DeliveryGuarantee::AtLeastOnce)
            .await?;
        Ok((request_id, rx))
    }

    /// Handles an incoming response topic+payload. Returns `true` if it matched a pending request.
    ///
    /// Expected topic format: `amux/{teamId}/{actorId}/rpc/res`
    pub fn handle_response(&mut self, topic: &str, payload: &[u8]) -> bool {
        let parts: Vec<&str> = topic.split('/').collect();
        // amux / {teamId} / {actorId} / rpc / res
        if parts.len() != 5 {
            return false;
        }
        if parts[0] != "amux" || parts[3] != "rpc" || parts[4] != "res" {
            return false;
        }
        if let Ok(response) = RpcResponse::decode(payload) {
            let request_id = response.request_id.as_str();
            if let Some(tx) = self.remote_tool_pending.remove(request_id) {
                if remote_tool_response_is_skippable(&response) {
                    self.remote_tool_pending.insert(request_id.to_string(), tx);
                    return true;
                }
                let _ = tx.send(response);
                return true;
            }
            if let Some(tx) = self.pending.remove(request_id) {
                let _ = tx.send(response);
                return true;
            }
        }
        false
    }

    /// Generates a unique request ID for RPC correlation.
    pub fn new_request_id() -> String {
        Uuid::new_v4().to_string()
    }
}

fn remote_tool_response_is_skippable(response: &RpcResponse) -> bool {
    if let Some(rpc_response::Result::RemoteToolInvokeResult(result)) = &response.result {
        return !result.success && result.error_code == "unsupported_platform";
    }
    !response.success && response.error.contains("unsupported_platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message as ProstMessage;

    #[test]
    fn test_parse_request_valid() {
        let req = RpcRequest {
            request_id: "req123".to_string(),
            requester_client_id: String::new(),
            requester_actor_id: "actor-b".to_string(),
            method: Some(crate::proto::teamclaw::rpc_request::Method::FetchSession(
                crate::proto::teamclaw::FetchSessionRequest {
                    session_id: "s1".to_string(),
                },
            )),
        };
        let payload = req.encode_to_vec();
        let topic = "amux/team1/actor-a/rpc/req";

        let result = RpcServer::parse_request(topic, &payload);
        assert!(result.is_some());
        let (request_id, parsed) = result.unwrap();
        assert_eq!(request_id, "req123");
        assert_eq!(parsed.requester_actor_id, "actor-b");
    }

    #[test]
    fn test_parse_request_wrong_suffix() {
        let topic = "amux/team1/actor-a/rpc/res"; // "res" not "req"
        assert!(RpcServer::parse_request(topic, &[]).is_none());
    }

    #[test]
    fn test_parse_request_wrong_part_count() {
        let topic = "amux/team1/actor-a/rpc"; // too few parts
        assert!(RpcServer::parse_request(topic, &[]).is_none());
    }

    #[test]
    fn test_parse_request_invalid_payload() {
        let topic = "amux/team1/actor-a/rpc/req";
        assert!(RpcServer::parse_request(topic, b"not protobuf").is_none());
    }

    #[test]
    fn test_handle_response_valid() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (client, _eventloop) =
                rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
            let mut rpc_client = RpcClient::new(
                Arc::new(client) as Arc<dyn MessagePublisher>,
                "team1".to_string(),
                "actor-a".to_string(),
            );

            // Manually insert a pending request
            let (tx, rx) = oneshot::channel();
            rpc_client.pending.insert("req123".to_string(), tx);

            let response = RpcResponse {
                request_id: "req123".to_string(),
                success: true,
                error: String::new(),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                result: None,
            };
            let payload = response.encode_to_vec();
            let topic = "amux/team1/actor-a/rpc/res";

            let matched = rpc_client.handle_response(topic, &payload);
            assert!(matched);
            assert!(rpc_client.pending.is_empty());

            let received = rx.await.unwrap();
            assert!(received.success);
        });
    }

    #[test]
    fn test_handle_response_no_pending() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (client, _eventloop) =
                rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
            let mut rpc_client = RpcClient::new(
                Arc::new(client) as Arc<dyn MessagePublisher>,
                "team1".to_string(),
                "actor-a".to_string(),
            );

            let response = RpcResponse {
                request_id: "req999".to_string(),
                success: true,
                error: String::new(),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                result: None,
            };
            let payload = response.encode_to_vec();
            let topic = "amux/team1/actor-a/rpc/res";

            let matched = rpc_client.handle_response(topic, &payload);
            assert!(!matched); // no pending request
        });
    }

    #[test]
    fn test_handle_response_wrong_topic() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (client, _eventloop) =
                rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
            let mut rpc_client = RpcClient::new(
                Arc::new(client) as Arc<dyn MessagePublisher>,
                "team1".to_string(),
                "actor-a".to_string(),
            );
            let matched = rpc_client.handle_response("bad/topic", &[]);
            assert!(!matched);
        });
    }

    #[test]
    fn test_new_request_id_is_full_uuid() {
        let id = RpcClient::new_request_id();
        assert_eq!(id.len(), 36);
        assert!(id.contains('-'));
    }

    #[test]
    fn test_remote_tool_pending_skips_unsupported_platform() {
        let (client, _eventloop) =
            rumqttc::AsyncClient::new(rumqttc::MqttOptions::new("test", "localhost", 1883), 10);
        let mut rpc_client = RpcClient::new(
            Arc::new(client) as Arc<dyn teamclaw_transport::MessagePublisher>,
            "team1".to_string(),
            "daemon".to_string(),
        );

        let (tx, mut rx) = oneshot::channel();
        rpc_client
            .remote_tool_pending
            .insert("req-remote".to_string(), tx);

        let skip = RpcResponse {
            request_id: "req-remote".to_string(),
            success: false,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: Some(rpc_response::Result::RemoteToolInvokeResult(
                crate::proto::teamclaw::RemoteToolInvokeResult {
                    success: false,
                    result_json: String::new(),
                    error_code: "unsupported_platform".to_string(),
                    error_message: "skip".to_string(),
                },
            )),
        };
        let payload = skip.encode_to_vec();
        let topic = "amux/team1/daemon/rpc/res";

        assert!(rpc_client.handle_response(topic, &payload));
        assert!(rpc_client.remote_tool_pending.contains_key("req-remote"));
        assert!(rx.try_recv().is_err());

        let ok = RpcResponse {
            request_id: "req-remote".to_string(),
            success: true,
            error: String::new(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            result: Some(rpc_response::Result::RemoteToolInvokeResult(
                crate::proto::teamclaw::RemoteToolInvokeResult {
                    success: true,
                    result_json: r#"{"url":"https://example.com"}"#.to_string(),
                    error_code: String::new(),
                    error_message: String::new(),
                },
            )),
        };
        let payload = ok.encode_to_vec();
        assert!(rpc_client.handle_response(topic, &payload));
        assert!(rpc_client.remote_tool_pending.is_empty());
        assert!(rx.try_recv().unwrap().success);
    }
}

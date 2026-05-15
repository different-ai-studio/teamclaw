use crate::proto::teamclaw::{RpcRequest, RpcResponse};
use prost::Message as ProstMessage;
use rumqttc::{AsyncClient, QoS};
use std::collections::HashMap;
use tokio::sync::oneshot;
use uuid::Uuid;

/// Server-side RPC handler: receives requests and sends responses.
pub struct RpcServer {
    pub client: AsyncClient,
    pub team_id: String,
    pub device_id: String,
}

impl RpcServer {
    pub fn new(client: AsyncClient, team_id: String, device_id: String) -> Self {
        Self {
            client,
            team_id,
            device_id,
        }
    }

    /// Parses an MQTT topic and payload into a (request_id, RpcRequest) pair.
    ///
    /// Expected topic format: `amux/{teamId}/device/{targetDeviceId}/rpc/req`
    pub fn parse_request(topic: &str, payload: &[u8]) -> Option<(String, RpcRequest)> {
        let parts: Vec<&str> = topic.split('/').collect();
        // amux / {teamId} / device / {targetDeviceId} / rpc / req
        if parts.len() != 6 {
            return None;
        }
        if parts[0] != "amux" || parts[2] != "device" || parts[4] != "rpc" || parts[5] != "req" {
            return None;
        }
        let request = RpcRequest::decode(payload).ok()?;
        if request.request_id.is_empty() {
            return None;
        }
        Some((request.request_id.clone(), request))
    }

    /// Publishes an RPC response back to the sender's device.
    ///
    /// Response topic: `amux/{teamId}/device/{senderDeviceId}/rpc/res`
    pub async fn respond(&self, request: &RpcRequest, response: RpcResponse) {
        let topic = format!(
            "amux/{}/device/{}/rpc/res",
            self.team_id, request.sender_device_id
        );
        let payload = response.encode_to_vec();
        if let Err(e) = self
            .client
            .publish(topic, QoS::AtLeastOnce, false, payload)
            .await
        {
            tracing::warn!("RpcServer: failed to publish response: {e}");
        }
    }
}

/// Client-side RPC handler: sends requests and waits for responses via oneshot channels.
pub struct RpcClient {
    pub client: AsyncClient,
    pub team_id: String,
    pub device_id: String,
    pub pending: HashMap<String, oneshot::Sender<RpcResponse>>,
}

impl RpcClient {
    pub fn new(client: AsyncClient, team_id: String, device_id: String) -> Self {
        Self {
            client,
            team_id,
            device_id,
            pending: HashMap::new(),
        }
    }

    /// Sends an RPC request to `target_device_id` and returns a receiver for the response.
    pub async fn request(
        &mut self,
        target_device_id: &str,
        mut request: RpcRequest,
    ) -> crate::error::Result<oneshot::Receiver<RpcResponse>> {
        let request_id = Self::new_request_id();
        request.request_id = request_id.clone();
        let topic = format!("amux/{}/device/{}/rpc/req", self.team_id, target_device_id);
        let payload = request.encode_to_vec();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(request_id.clone(), tx);
        self.client
            .publish(topic, QoS::AtLeastOnce, false, payload)
            .await?;
        Ok(rx)
    }

    /// Handles an incoming response topic+payload. Returns `true` if it matched a pending request.
    ///
    /// Expected topic format: `amux/{teamId}/device/{deviceId}/rpc/res`
    pub fn handle_response(&mut self, topic: &str, payload: &[u8]) -> bool {
        let parts: Vec<&str> = topic.split('/').collect();
        // amux / {teamId} / device / {deviceId} / rpc / res
        if parts.len() != 6 {
            return false;
        }
        if parts[0] != "amux" || parts[2] != "device" || parts[4] != "rpc" || parts[5] != "res" {
            return false;
        }
        if let Ok(response) = RpcResponse::decode(payload) {
            if let Some(tx) = self.pending.remove(response.request_id.as_str()) {
                let _ = tx.send(response);
                return true;
            }
        }
        false
    }

    /// Generates an 8-character request ID from a UUID.
    pub fn new_request_id() -> String {
        Uuid::new_v4().to_string()[..8].to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message as ProstMessage;

    #[test]
    fn test_parse_request_valid() {
        let req = RpcRequest {
            request_id: "req123".to_string(),
            sender_device_id: "dev-b".to_string(),
            requester_client_id: String::new(),
            requester_actor_id: String::new(),
            requester_device_id: String::new(),
            method: Some(crate::proto::teamclaw::rpc_request::Method::FetchSession(
                crate::proto::teamclaw::FetchSessionRequest {
                    session_id: "s1".to_string(),
                },
            )),
        };
        let payload = req.encode_to_vec();
        let topic = "amux/team1/device/dev-a/rpc/req";

        let result = RpcServer::parse_request(topic, &payload);
        assert!(result.is_some());
        let (request_id, parsed) = result.unwrap();
        assert_eq!(request_id, "req123");
        assert_eq!(parsed.sender_device_id, "dev-b");
    }

    #[test]
    fn test_parse_request_wrong_suffix() {
        let topic = "amux/team1/device/dev-a/rpc/res"; // "res" not "req"
        assert!(RpcServer::parse_request(topic, &[]).is_none());
    }

    #[test]
    fn test_parse_request_wrong_part_count() {
        let topic = "amux/team1/device/dev-a/rpc"; // too few parts
        assert!(RpcServer::parse_request(topic, &[]).is_none());
    }

    #[test]
    fn test_parse_request_invalid_payload() {
        let topic = "amux/team1/device/dev-a/rpc/req";
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
            let mut rpc_client = RpcClient::new(client, "team1".to_string(), "dev-a".to_string());

            // Manually insert a pending request
            let (tx, rx) = oneshot::channel();
            rpc_client.pending.insert("req123".to_string(), tx);

            let response = RpcResponse {
                request_id: "req123".to_string(),
                success: true,
                error: String::new(),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                requester_device_id: String::new(),
                result: None,
            };
            let payload = response.encode_to_vec();
            let topic = "amux/team1/device/dev-a/rpc/res";

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
            let mut rpc_client = RpcClient::new(client, "team1".to_string(), "dev-a".to_string());

            let response = RpcResponse {
                request_id: "req999".to_string(),
                success: true,
                error: String::new(),
                requester_client_id: String::new(),
                requester_actor_id: String::new(),
                requester_device_id: String::new(),
                result: None,
            };
            let payload = response.encode_to_vec();
            let topic = "amux/team1/device/dev-a/rpc/res";

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
            let mut rpc_client = RpcClient::new(client, "team1".to_string(), "dev-a".to_string());
            let matched = rpc_client.handle_response("bad/topic", &[]);
            assert!(!matched);
        });
    }

    #[test]
    fn test_new_request_id_format() {
        let id = RpcClient::new_request_id();
        assert_eq!(id.len(), 8);
    }
}

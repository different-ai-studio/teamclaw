use axum::{
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::any,
    Router,
};
use reqwest::Client;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ProxyConfig {
    pub target_url: String,
    pub client: Client,
}

pub struct ProxyServer {
    server_handle: Option<tokio::task::JoinHandle<()>>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl ProxyServer {
    pub fn new() -> Self {
        Self {
            server_handle: None,
            shutdown_tx: None,
        }
    }

    pub async fn start(&mut self, port: u16, target_url: String) -> Result<(), String> {
        if self.server_handle.is_some() {
            return Err("Proxy server is already running".to_string());
        }

        let config = ProxyConfig {
            target_url: target_url.clone(),
            client: Client::builder()
                .pool_max_idle_per_host(10)
                .pool_idle_timeout(std::time::Duration::from_secs(90))
                .connect_timeout(std::time::Duration::from_secs(30))
                .tcp_keepalive(std::time::Duration::from_secs(60))
                .tcp_nodelay(true) // 禁用 Nagle 算法，减少延迟
                .http2_keep_alive_interval(Some(std::time::Duration::from_secs(30)))
                .http2_keep_alive_timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| format!("Failed to create HTTP client: {}", e))?,
        };

        let app = Router::new()
            .route("/*path", any(proxy_handler))
            .with_state(Arc::new(config));

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        let addr = format!("127.0.0.1:{}", port);
        println!("[LLM Proxy] Starting internal proxy on {}...", addr);
        println!("[LLM Proxy] Proxying to {}", target_url);

        let server_handle = tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[LLM Proxy] Failed to bind to {}: {}", addr, e);
                    return;
                }
            };

            println!("[LLM Proxy] Listening on http://{}", addr);

            if let Err(e) = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    shutdown_rx.await.ok();
                })
                .await
            {
                eprintln!("[LLM Proxy] Server error: {}", e);
            }
        });

        self.server_handle = Some(server_handle);
        self.shutdown_tx = Some(shutdown_tx);

        Ok(())
    }

    pub async fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        if let Some(handle) = self.server_handle.take() {
            println!("[LLM Proxy] Stopping internal proxy...");
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
        }
    }
}

async fn proxy_handler(
    State(config): State<Arc<ProxyConfig>>,
    req: Request,
) -> Result<Response, StatusCode> {
    let method = req.method().clone();
    let headers = req.headers().clone();
    let uri = req.uri();
    
    // Extract path and query
    let mut incoming_path = uri.path().to_string();
    let query = uri.query().unwrap_or("");

    println!("[LLM Proxy] {} {}{}", method, incoming_path, if query.is_empty() { String::new() } else { format!("?{}", query) });

    // Strip /v1 prefix if present (target URL already includes it)
    if incoming_path.starts_with("/v1/") {
        incoming_path = incoming_path[3..].to_string(); // keep leading /
    } else if incoming_path == "/v1" {
        incoming_path = String::new();
    }

    // Build target URL
    let target_base = config.target_url.trim_end_matches('/');
    let full_path = if incoming_path.is_empty() {
        target_base.to_string()
    } else {
        format!("{}{}", target_base, incoming_path)
    };
    
    let target_url = if query.is_empty() {
        full_path
    } else {
        format!("{}?{}", full_path, query)
    };

    println!("[LLM Proxy] Forwarding to: {}", target_url);

    // Read request body with 10MB limit
    let body_bytes = match axum::body::to_bytes(req.into_body(), 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[LLM Proxy] Failed to read request body: {}", e);
            return Err(StatusCode::BAD_REQUEST);
        }
    };

    // Rewrite body for POST requests
    let final_body = if method == axum::http::Method::POST && !body_bytes.is_empty() {
        rewrite_request_body(&body_bytes)
    } else {
        body_bytes.to_vec()
    };

    // Check if this is a streaming request
    let is_streaming = std::str::from_utf8(&body_bytes)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.get("stream").and_then(|s| s.as_bool()))
        .unwrap_or(false);

    // Build forwarded request with longer timeout for streaming
    let timeout_duration = if is_streaming {
        std::time::Duration::from_secs(300) // 5分钟用于流式响应
    } else {
        std::time::Duration::from_secs(120) // 2分钟用于普通响应
    };

    let mut req_builder = config.client
        .request(
            method.as_str().parse().unwrap(),
            &target_url,
        )
        .timeout(timeout_duration);

    // Copy headers (skip host and content-length)
    for (key, value) in headers.iter() {
        let key_str = key.as_str();
        if key_str != "host" && key_str != "content-length" {
            if let Ok(value_str) = value.to_str() {
                req_builder = req_builder.header(key_str, value_str);
            }
        }
    }

    // Send request
    let response = match req_builder.body(final_body).send().await {
        Ok(r) => {
            let status = r.status();
            println!("[LLM Proxy] Response status: {}", status);
            
            // Check for rate limiting / quota errors
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                eprintln!("[LLM Proxy] ⚠️  Rate limit exceeded (429)");
                if let Some(retry_after) = r.headers().get("retry-after") {
                    if let Ok(seconds) = retry_after.to_str() {
                        eprintln!("[LLM Proxy] Retry after: {} seconds", seconds);
                    }
                }
            } else if status.as_u16() == 402 {
                eprintln!("[LLM Proxy] ⚠️  Payment required (402) - quota may be exhausted");
            } else if status == reqwest::StatusCode::UNAUTHORIZED {
                eprintln!("[LLM Proxy] ⚠️  Unauthorized (401) - check API key");
            } else if status == reqwest::StatusCode::FORBIDDEN {
                eprintln!("[LLM Proxy] ⚠️  Forbidden (403) - insufficient permissions or quota");
            }
            
            r
        },
        Err(e) => {
            eprintln!("[LLM Proxy] Request failed: {}", e);
            if e.is_timeout() {
                return Err(StatusCode::GATEWAY_TIMEOUT);
            } else if e.is_connect() {
                return Err(StatusCode::BAD_GATEWAY);
            } else {
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
        }
    };

    // Build response
    let status = response.status();
    let response_headers = response.headers().clone();

    // Check if response is streaming (SSE)
    let is_sse = response_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/event-stream"))
        .unwrap_or(false);

    if is_sse {
        println!("[LLM Proxy] Streaming response detected (SSE) - using stream passthrough");
        
        // Log quota/rate limit headers if present
        if let Some(remaining) = response_headers.get("x-ratelimit-remaining") {
            if let Ok(val) = remaining.to_str() {
                println!("[LLM Proxy] Rate limit remaining: {}", val);
            }
        }
        if let Some(limit) = response_headers.get("x-ratelimit-limit") {
            if let Ok(val) = limit.to_str() {
                println!("[LLM Proxy] Rate limit total: {}", val);
            }
        }
        
        // For SSE, stream the response body directly without buffering
        let mut resp = Response::builder()
            .status(status.as_u16());

        // Copy response headers
        for (key, value) in response_headers.iter() {
            if let Ok(v) = axum::http::HeaderValue::from_bytes(value.as_bytes()) {
                resp = resp.header(key.as_str(), v);
            }
        }

        // Stream the body directly using reqwest's byte stream
        let stream = response.bytes_stream();
        let body = Body::from_stream(stream);
        
        let resp = resp.body(body).unwrap();
        println!("[LLM Proxy] Streaming response initiated");
        
        return Ok(resp);
    }

    // For non-SSE responses, read the full body
    let response_body = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[LLM Proxy] Failed to read response body: {}", e);
            if e.is_timeout() {
                eprintln!("[LLM Proxy] Timeout while reading response (may be normal for very long responses)");
            }
            return Err(StatusCode::BAD_GATEWAY);
        }
    };

    // Check response body for actual errors (when status is 200 but body contains error info)
    if status.is_success() {
        if let Ok(body_text) = std::str::from_utf8(&response_body) {
            // Parse as JSON to check for error structure
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(body_text) {
                if let Some(error_obj) = json.get("error") {
                    // Has {"error": {...}} structure - log the full error
                    eprintln!("[LLM Proxy] ⚠️  API error in response: {}", 
                        serde_json::to_string_pretty(error_obj).unwrap_or_else(|_| error_obj.to_string())
                    );
                }
            } else {
                // Not valid JSON, check for error keywords in plain text
                let lower_body = body_text.to_lowercase();
                if (lower_body.contains("quota") && lower_body.contains("exceed")) || 
                   lower_body.contains("rate limit") {
                    let preview = if body_text.len() > 300 {
                        format!("{}...", &body_text[..300])
                    } else {
                        body_text.to_string()
                    };
                    eprintln!("[LLM Proxy] ⚠️  Potential quota/rate limit in response: {}", preview);
                }
            }
        }
    }

    // Log quota/rate limit headers if present
    if let Some(remaining) = response_headers.get("x-ratelimit-remaining") {
        if let Ok(val) = remaining.to_str() {
            println!("[LLM Proxy] Rate limit remaining: {}", val);
        }
    }
    if let Some(limit) = response_headers.get("x-ratelimit-limit") {
        if let Ok(val) = limit.to_str() {
            println!("[LLM Proxy] Rate limit total: {}", val);
        }
    }

    let mut resp = Response::builder()
        .status(status.as_u16());

    // Copy response headers
    for (key, value) in response_headers.iter() {
        if let Ok(v) = axum::http::HeaderValue::from_bytes(value.as_bytes()) {
            resp = resp.header(key.as_str(), v);
        }
    }

    let resp = resp
        .body(Body::from(response_body.to_vec()))
        .unwrap();

    println!("[LLM Proxy] Response sent: {} bytes", response_body.len());

    Ok(resp)
}

fn rewrite_request_body(body: &[u8]) -> Vec<u8> {
    let body_str = match std::str::from_utf8(body) {
        Ok(s) => s,
        Err(_) => return body.to_vec(),
    };

    let mut data: Value = match serde_json::from_str(body_str) {
        Ok(d) => d,
        Err(_) => return body.to_vec(),
    };

    let obj = match data.as_object_mut() {
        Some(o) => o,
        None => return body.to_vec(),
    };

    // Rewrite max_tokens -> max_completion_tokens
    if let Some(max_tokens) = obj.remove("max_tokens") {
        obj.insert("max_completion_tokens".to_string(), max_tokens);
    }

    // Fix empty tool role content
    if let Some(messages) = obj.get_mut("messages") {
        if let Some(messages_array) = messages.as_array_mut() {
            for (i, msg) in messages_array.iter_mut().enumerate() {
                if let Some(msg_obj) = msg.as_object_mut() {
                    if let Some(role) = msg_obj.get("role") {
                        if role.as_str() == Some("tool") {
                            let mut empty = false;

                            if let Some(content) = msg_obj.get("content") {
                                if content.is_null() {
                                    empty = true;
                                } else if let Some(s) = content.as_str() {
                                    empty = s.trim().is_empty();
                                } else if let Some(arr) = content.as_array() {
                                    empty = arr.is_empty()
                                        || arr.iter().all(|p| {
                                            if let Some(obj) = p.as_object() {
                                                if let Some(text) = obj.get("text") {
                                                    if let Some(t) = text.as_str() {
                                                        return t.trim().is_empty();
                                                    }
                                                }
                                            }
                                            false
                                        });
                                }
                            } else {
                                empty = true;
                            }

                            if empty {
                                let tool_call_id = msg_obj
                                    .get("tool_call_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown");
                                
                                println!(
                                    "[LLM Proxy] Fixing empty tool content at message[{}], tool_call_id={}, original: {:?}",
                                    i, tool_call_id, msg_obj.get("content")
                                );
                                
                                msg_obj.insert("content".to_string(), Value::String("(empty)".to_string()));
                            }
                        }
                    }
                }
            }
        }
    }

    serde_json::to_vec(&data).unwrap_or_else(|_| body.to_vec())
}

pub type ProxyServerHandle = Arc<Mutex<ProxyServer>>;

pub fn create_proxy_handle() -> ProxyServerHandle {
    Arc::new(Mutex::new(ProxyServer::new()))
}

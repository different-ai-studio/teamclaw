//! JSONL command client for one sidecar child process.
//!
//! Shared by every sidecar-style backend (`cursor_sdk`, `claude_agent`): the
//! wire shape is `{id, method, params}` out, `{id, result|error}` back, with
//! events (no `id`) interleaved on the same stdout stream and routed by the
//! owning backend rather than here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tracing::warn;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

struct Inner {
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    pending: parking_lot::Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    next_id: AtomicU64,
}

#[derive(Clone)]
pub struct SidecarClient(Arc<Inner>);

impl SidecarClient {
    pub fn new(stdin: tokio::process::ChildStdin) -> Self {
        Self(Arc::new(Inner {
            stdin: tokio::sync::Mutex::new(stdin),
            pending: parking_lot::Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }))
    }

    async fn write_line(&self, value: &serde_json::Value) -> crate::error::Result<()> {
        let mut line = serde_json::to_string(value)
            .map_err(|e| crate::error::AmuxError::Agent(format!("sidecar command encode: {e}")))?;
        line.push('\n');
        let mut stdin = self.0.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("sidecar stdin write: {e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("sidecar stdin flush: {e}")))
    }

    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> crate::error::Result<serde_json::Value> {
        let id = format!("tc-{}", self.0.next_id.fetch_add(1, Ordering::Relaxed));
        let cmd = serde_json::json!({ "id": id, "method": method, "params": params });

        let (tx, rx) = oneshot::channel();
        self.0.pending.lock().insert(id.clone(), tx);
        if let Err(e) = self.write_line(&cmd).await {
            self.0.pending.lock().remove(&id);
            return Err(e);
        }

        let response = match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => {
                return Err(crate::error::AmuxError::Agent(format!(
                    "{method}: bridge exited before responding"
                )))
            }
            Err(_) => {
                self.0.pending.lock().remove(&id);
                return Err(crate::error::AmuxError::Agent(format!(
                    "{method}: response timed out"
                )));
            }
        };

        if let Some(err) = response.get("error").and_then(|v| v.as_str()) {
            return Err(crate::error::AmuxError::Agent(format!(
                "{method} failed: {err}"
            )));
        }
        Ok(response
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }

    pub fn resolve_response(&self, response: &serde_json::Value) -> bool {
        let Some(id) = response.get("id").and_then(|v| v.as_str()) else {
            return false;
        };
        match self.0.pending.lock().remove(id) {
            Some(tx) => {
                let _ = tx.send(response.clone());
                true
            }
            None => {
                warn!(id, "sidecar response with no pending request");
                false
            }
        }
    }

    pub fn fail_all_pending(&self) {
        self.0.pending.lock().clear();
    }
}

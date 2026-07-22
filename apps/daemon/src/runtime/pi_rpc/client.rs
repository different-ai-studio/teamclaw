//! JSONL command client for one `pi --mode rpc` child process.
//!
//! Commands are JSON objects written to the child's stdin, one per line, with
//! a monotonically increasing string `id`. The stdout reader (`events.rs`)
//! routes `{"type":"response", ...}` lines back here via
//! [`PiClient::resolve_response`]; everything else is an event.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tracing::warn;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

struct Inner {
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    pending: parking_lot::Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    next_id: AtomicU64,
}

/// Cloneable handle for writing commands to a pi RPC child.
#[derive(Clone)]
pub struct PiClient(Arc<Inner>);

impl PiClient {
    pub fn new(stdin: tokio::process::ChildStdin) -> Self {
        Self(Arc::new(Inner {
            stdin: tokio::sync::Mutex::new(stdin),
            pending: parking_lot::Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }))
    }

    async fn write_line(&self, value: &serde_json::Value) -> crate::error::Result<()> {
        let mut line = serde_json::to_string(value)
            .map_err(|e| crate::error::AmuxError::Agent(format!("pi command encode: {e}")))?;
        line.push('\n');
        let mut stdin = self.0.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("pi stdin write: {e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| crate::error::AmuxError::Agent(format!("pi stdin flush: {e}")))
    }

    /// Send a command without expecting a response (e.g.
    /// `extension_ui_response`).
    pub async fn notify(&self, cmd: serde_json::Value) -> crate::error::Result<()> {
        self.write_line(&cmd).await
    }

    /// Send a command with a correlation `id` and await its
    /// `{"type":"response"}` line. Fails on `success: false`, process death
    /// (pending sender dropped) or a 30s timeout.
    pub async fn request(
        &self,
        mut cmd: serde_json::Value,
    ) -> crate::error::Result<serde_json::Value> {
        let id = format!("amux-{}", self.0.next_id.fetch_add(1, Ordering::Relaxed));
        let command = cmd
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        cmd.as_object_mut()
            .ok_or_else(|| crate::error::AmuxError::Agent("pi command must be an object".into()))?
            .insert("id".to_string(), serde_json::json!(id));

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
                    "pi {command}: process exited before responding"
                )))
            }
            Err(_) => {
                self.0.pending.lock().remove(&id);
                return Err(crate::error::AmuxError::Agent(format!(
                    "pi {command}: response timed out"
                )));
            }
        };
        if response.get("success").and_then(|v| v.as_bool()) == Some(false) {
            let error = response
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(crate::error::AmuxError::Agent(format!(
                "pi {command} failed: {error}"
            )));
        }
        Ok(response)
    }

    /// Route a `{"type":"response"}` stdout line to its awaiting request.
    /// Returns false when no matching pending request exists.
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
                warn!(id, "pi response with no pending request");
                false
            }
        }
    }

    /// Drop all pending requests (process died); awaiting callers get an
    /// immediate "process exited" error instead of the 30s timeout.
    pub fn fail_all_pending(&self) {
        self.0.pending.lock().clear();
    }
}

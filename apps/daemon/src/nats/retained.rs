//! JetStream KV-backed replacement for MQTT retained messages.
//!
//! NATS core has no retained-message concept. The daemon's retained writes
//! ({actor}/state, runtime/{id}/state) instead persist to a JetStream
//! KV bucket called `amux_state`. Subscribers that need the latest value
//! for a topic read it from KV on (re)connect rather than relying on
//! broker-side retention.
//!
//! KV keys are derived from MQTT topics by replacing '/' with '_' (NATS
//! KV keys can contain alphanumerics, `-`, `_`, `=`, and `/`; we pick `_`
//! to match the daemon's local convention and avoid subject-path collision).
//!
//! Bucket is created idempotently on daemon connect; if it already exists
//! with the right config, the existing bucket is reused.

use async_nats::jetstream::{self, kv};
use async_nats::Client;
use tracing::info;

const BUCKET_NAME: &str = "amux_state";
const HISTORY: i64 = 1;
const MAX_BYTES: i64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct RetainedKv {
    bucket: kv::Store,
}

impl RetainedKv {
    pub async fn ensure(client: &Client) -> crate::error::Result<Self> {
        let js = jetstream::new(client.clone());
        let bucket = match js
            .create_key_value(kv::Config {
                bucket: BUCKET_NAME.to_string(),
                history: HISTORY,
                max_bytes: MAX_BYTES,
                ..Default::default()
            })
            .await
        {
            Ok(b) => {
                info!(bucket = BUCKET_NAME, "JetStream KV bucket created");
                b
            }
            Err(e) => {
                // Already exists path — try to bind.
                let msg = e.to_string();
                if msg.contains("already") || msg.contains("exists") {
                    let b = js
                        .get_key_value(BUCKET_NAME)
                        .await
                        .map_err(|e| crate::error::AmuxError::Config(format!("kv bind: {e}")))?;
                    info!(bucket = BUCKET_NAME, "JetStream KV bucket reused");
                    b
                } else {
                    return Err(crate::error::AmuxError::Config(format!("kv create: {msg}")));
                }
            }
        };
        Ok(Self { bucket })
    }

    fn key(topic: &str) -> String {
        topic.replace('/', "_")
    }

    pub async fn put(&self, topic: &str, payload: Vec<u8>) -> crate::error::Result<()> {
        self.bucket
            .put(Self::key(topic), payload.into())
            .await
            .map_err(|e| crate::error::AmuxError::Config(format!("kv put: {e}")))?;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn delete(&self, topic: &str) -> crate::error::Result<()> {
        self.bucket
            .delete(Self::key(topic))
            .await
            .map_err(|e| crate::error::AmuxError::Config(format!("kv delete: {e}")))?;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn get(&self, topic: &str) -> crate::error::Result<Option<Vec<u8>>> {
        let entry = self
            .bucket
            .entry(Self::key(topic))
            .await
            .map_err(|e| crate::error::AmuxError::Config(format!("kv get: {e}")))?;
        Ok(entry.map(|e| e.value.to_vec()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_replaces_slash_with_underscore() {
        assert_eq!(
            RetainedKv::key("amux/team1/actor-a/state"),
            "amux_team1_actor-a_state"
        );
    }
}

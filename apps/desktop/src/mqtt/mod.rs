pub mod client;
pub mod topics;

pub use client::{ClientConfig, MqttClient};

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct MqttBusInner {
    pub client: Mutex<Option<MqttClient>>,
    pub subscribed: Mutex<HashSet<String>>,
    /// True only after the event loop has observed a CONNACK and not yet seen
    /// a network/disconnect error. The `client` handle being `Some(_)` only
    /// proves the wrapper struct exists — it can outlive a broken TCP/TLS
    /// connection, which is why we need this separate flag for honest UI
    /// status.
    pub connected: AtomicBool,
    /// Monotonic token for the currently-owned MQTT connection. Reconnects
    /// replace the client and spawn a new event loop; older event loops exit
    /// when their captured generation no longer matches this value.
    pub generation: AtomicU64,
}

impl MqttBusInner {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            subscribed: Mutex::new(HashSet::new()),
            connected: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    pub fn set_connected(&self, value: bool) {
        self.connected.store(value, Ordering::Release);
    }

    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub async fn force_reconnect(&self) {
        self.set_connected(false);
        if let Some(client) = self.client.lock().await.as_ref() {
            let _ = client.client.disconnect().await;
        }
    }
}

pub type MqttBus = Arc<MqttBusInner>;

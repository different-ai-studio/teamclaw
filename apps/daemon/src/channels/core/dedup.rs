//! One dedup store for every channel.
//!
//! Replaces three mechanisms that each forgot differently: WeCom's in-memory
//! `ProcessedMessageTracker`, Feishu's nothing-at-all, and email's UID
//! watermark plus sqlite table. A redelivered webhook is a normal event on
//! every one of these transports; only one of them handled it.

use std::collections::{HashSet, VecDeque};

use async_trait::async_trait;
use tokio::sync::Mutex;

use super::DedupStore;

/// Bounded, in-process, FIFO-evicting.
///
/// In-process is honest about what it protects against: a webhook redelivered
/// seconds later while this daemon is up. It does NOT survive a restart — and
/// must not pretend to, because the store that would (the messages table's
/// `external_message_id` uniqueness) is already the durable backstop.
pub struct MemoryDedup {
    inner: Mutex<Inner>,
    capacity: usize,
}

struct Inner {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl MemoryDedup {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                seen: HashSet::new(),
                order: VecDeque::new(),
            }),
            capacity: capacity.max(1),
        }
    }
}

impl Default for MemoryDedup {
    /// Matches WeCom's old `MAX_PROCESSED_MESSAGES`, which was sized for the
    /// same job.
    fn default() -> Self {
        Self::new(1000)
    }
}

#[async_trait]
impl DedupStore for MemoryDedup {
    async fn claim(&self, channel: &str, external_message_id: &str) -> bool {
        // Keyed by channel so two transports cannot collide on a shared id
        // shape (a bare integer, a uuid) and silently swallow each other's
        // messages.
        let key = format!("{channel}:{external_message_id}");
        let mut inner = self.inner.lock().await;
        if !inner.seen.insert(key.clone()) {
            return false;
        }
        inner.order.push_back(key);
        while inner.order.len() > self.capacity {
            if let Some(evicted) = inner.order.pop_front() {
                inner.seen.remove(&evicted);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_first_sighting_wins_and_the_rest_lose() {
        let d = MemoryDedup::default();
        assert!(d.claim("wecom", "m-1").await);
        assert!(!d.claim("wecom", "m-1").await);
        assert!(!d.claim("wecom", "m-1").await);
    }

    #[tokio::test]
    async fn two_channels_do_not_collide_on_the_same_id() {
        // Email uses bare UIDs and WeCom uses its own ids; without the channel
        // in the key, "42" from one would silence "42" from the other.
        let d = MemoryDedup::default();
        assert!(d.claim("wecom", "42").await);
        assert!(d.claim("email", "42").await);
    }

    #[tokio::test]
    async fn the_oldest_entry_is_evicted_not_the_newest() {
        let d = MemoryDedup::new(2);
        assert!(d.claim("wecom", "a").await);
        assert!(d.claim("wecom", "b").await);
        assert!(d.claim("wecom", "c").await); // evicts "a"

        assert!(d.claim("wecom", "a").await, "a was forgotten, as designed");
        assert!(!d.claim("wecom", "c").await, "c is still remembered");
    }
}

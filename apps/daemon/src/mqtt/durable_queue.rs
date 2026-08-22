//! Small append-only durable queues used by the MQTT supervisor.
//!
//! The queue is deliberately independent of the MQTT generation.  A worker
//! can therefore be rebuilt without losing messages that were accepted by the
//! daemon but had not reached the broker (or the business executor) yet.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use teamclu_transport::{DeliveryGuarantee, IncomingFrame};

const COMPACT_AFTER_OPS: usize = 128;

#[derive(Debug, Serialize, Deserialize)]
enum LogRecord<T> {
    Put { id: u64, item: T },
    Ack { id: u64 },
}

/// A durable FIFO-ish queue. Ordering is recovered by the monotonically
/// increasing id, while the BTreeMap also gives us cheap idempotent ACKs.
struct DurableQueue<T> {
    path: PathBuf,
    entries: BTreeMap<u64, T>,
    next_id: u64,
    ops_since_compact: usize,
}

impl<T> DurableQueue<T>
where
    T: DeserializeOwned + Serialize,
{
    fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut entries = BTreeMap::new();
        let mut next_id = 1_u64;
        if path.is_file() {
            let file = File::open(&path)?;
            let reader = BufReader::new(file);
            let mut lines = reader.lines().peekable();
            let mut line_no = 0;
            while let Some(line) = lines.next() {
                line_no += 1;
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let record = match serde_json::from_str::<LogRecord<T>>(&line) {
                    Ok(record) => record,
                    Err(error) => {
                        // A process can be killed while appending the final
                        // line. Only that torn tail is recoverable. A
                        // malformed record with later records means the log
                        // is damaged in the middle and must not silently drop
                        // a durable message.
                        if lines.peek().is_some() {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!(
                                    "malformed durable queue record at line {}: {}",
                                    line_no, error
                                ),
                            ));
                        }
                        tracing::warn!(
                            path = %path.display(),
                            line = line_no,
                            %error,
                            "ignoring torn final durable MQTT queue record"
                        );
                        continue;
                    }
                };
                match record {
                    LogRecord::Put { id, item } => {
                        next_id = next_id.max(id.saturating_add(1));
                        entries.insert(id, item);
                    }
                    LogRecord::Ack { id } => {
                        entries.remove(&id);
                    }
                }
            }
        }

        Ok(Self {
            path,
            entries,
            next_id,
            ops_since_compact: 0,
        })
    }

    fn append_record(&mut self, record: &LogRecord<T>) -> io::Result<()> {
        let encoded = serde_json::to_vec(record)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(&encoded)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        self.ops_since_compact += 1;
        Ok(())
    }

    fn put(&mut self, item: T) -> io::Result<u64> {
        let id = self.next_id;
        let record = LogRecord::Put { id, item };
        self.append_record(&record)?;
        if let LogRecord::Put { id, item } = record {
            self.entries.insert(id, item);
        }
        self.next_id = id.saturating_add(1);
        Ok(id)
    }

    fn ack(&mut self, id: u64) -> io::Result<()> {
        if !self.entries.contains_key(&id) {
            return Ok(());
        }
        self.append_record(&LogRecord::Ack { id })?;
        self.entries.remove(&id);
        self.compact_if_needed()
    }

    fn get(&self, id: u64) -> Option<&T> {
        self.entries.get(&id)
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn values(&self) -> impl Iterator<Item = (u64, &T)> {
        self.entries.iter().map(|(&id, item)| (id, item))
    }

    fn compact_if_needed(&mut self) -> io::Result<()> {
        if self.ops_since_compact < COMPACT_AFTER_OPS
            || self.ops_since_compact < self.entries.len().max(1)
        {
            return Ok(());
        }
        self.compact()
    }

    fn compact(&mut self) -> io::Result<()> {
        let temp_path = self.path.with_extension("log.tmp");
        let result = (|| {
            let mut file = File::create(&temp_path)?;
            for (&id, item) in &self.entries {
                let record = LogRecord::Put { id, item };
                let encoded = serde_json::to_vec(&record)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                file.write_all(&encoded)?;
                file.write_all(b"\n")?;
            }
            file.sync_all()?;
            std::fs::rename(&temp_path, &self.path)?;
            Ok::<(), io::Error>(())
        })();
        if result.is_ok() {
            self.ops_since_compact = 0;
        } else {
            let _ = std::fs::remove_file(&temp_path);
        }
        result
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DurableInbound {
    pub(crate) topic: String,
    pub(crate) payload: Vec<u8>,
    pub(crate) retained: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DurablePublish {
    pub(crate) topic: String,
    pub(crate) payload: Vec<u8>,
    pub(crate) retain: bool,
    pub(crate) delivery: StoredDelivery,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(crate) enum StoredDelivery {
    AtMostOnce,
    AtLeastOnce,
    ExactlyOnce,
}

impl From<DeliveryGuarantee> for StoredDelivery {
    fn from(value: DeliveryGuarantee) -> Self {
        match value {
            DeliveryGuarantee::AtMostOnce => Self::AtMostOnce,
            DeliveryGuarantee::AtLeastOnce => Self::AtLeastOnce,
            DeliveryGuarantee::ExactlyOnce => Self::ExactlyOnce,
        }
    }
}

impl From<StoredDelivery> for DeliveryGuarantee {
    fn from(value: StoredDelivery) -> Self {
        match value {
            StoredDelivery::AtMostOnce => Self::AtMostOnce,
            StoredDelivery::AtLeastOnce => Self::AtLeastOnce,
            StoredDelivery::ExactlyOnce => Self::ExactlyOnce,
        }
    }
}

pub(crate) struct DurableMqttStore {
    inbox: DurableQueue<DurableInbound>,
    outbox: DurableQueue<DurablePublish>,
}

impl DurableMqttStore {
    pub(crate) fn open_default() -> io::Result<Self> {
        Self::open_at(crate::config::layout::active_state_dir().join("mqtt"))
    }

    pub(crate) fn open_at(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            inbox: DurableQueue::open(dir.join("inbox.log"))?,
            outbox: DurableQueue::open(dir.join("outbox.log"))?,
        })
    }

    pub(crate) fn enqueue_inbound(&mut self, frame: IncomingFrame) -> io::Result<u64> {
        self.inbox.put(DurableInbound {
            topic: frame.topic,
            payload: frame.payload,
            retained: frame.retained,
        })
    }

    pub(crate) fn ack_inbound(&mut self, id: u64) -> io::Result<()> {
        self.inbox.ack(id)
    }

    pub(crate) fn inbound(&self, id: u64) -> Option<&DurableInbound> {
        self.inbox.get(id)
    }

    pub(crate) fn inbound_len(&self) -> usize {
        self.inbox.len()
    }

    pub(crate) fn inbox_bytes(&self) -> usize {
        self.inbox
            .values()
            .map(|(_, item)| item.topic.len() + item.payload.len())
            .sum()
    }

    pub(crate) fn pending_inbound(&self) -> impl Iterator<Item = (u64, &DurableInbound)> {
        self.inbox.values()
    }

    pub(crate) fn enqueue_publish(&mut self, publish: DurablePublish) -> io::Result<u64> {
        self.outbox.put(publish)
    }

    pub(crate) fn ack_publish(&mut self, id: u64) -> io::Result<()> {
        self.outbox.ack(id)
    }

    pub(crate) fn outbox_len(&self) -> usize {
        self.outbox.len()
    }

    pub(crate) fn outbox(&self, id: u64) -> Option<&DurablePublish> {
        self.outbox.get(id)
    }

    pub(crate) fn outbox_bytes(&self) -> usize {
        self.outbox
            .values()
            .map(|(_, item)| item.topic.len() + item.payload.len())
            .sum()
    }

    pub(crate) fn pending_outbox(&self) -> impl Iterator<Item = (u64, &DurablePublish)> {
        self.outbox.values()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_replays_unacked_inbox_and_outbox_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let frame = IncomingFrame {
            topic: "amux/team/actor/notify".into(),
            payload: vec![1, 2, 3],
            retained: false,
        };
        let inbound_id;
        let outbound_id;
        {
            let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
            inbound_id = store.enqueue_inbound(frame.clone()).unwrap();
            outbound_id = store
                .enqueue_publish(DurablePublish {
                    topic: "amux/team/actor/state".into(),
                    payload: vec![4, 5],
                    retain: true,
                    delivery: StoredDelivery::AtLeastOnce,
                })
                .unwrap();
        }

        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        let stored = store.inbound(inbound_id).unwrap();
        assert_eq!(
            IncomingFrame {
                topic: stored.topic.clone(),
                payload: stored.payload.clone(),
                retained: stored.retained,
            },
            frame
        );
        assert_eq!(store.outbox_len(), 1);
        store.ack_inbound(inbound_id).unwrap();
        store.ack_publish(outbound_id).unwrap();
        assert_eq!(store.inbound_len(), 0);
        assert_eq!(store.outbox_len(), 0);
    }

    #[test]
    fn delivery_round_trips_without_using_transport_types_on_disk() {
        for value in [
            DeliveryGuarantee::AtMostOnce,
            DeliveryGuarantee::AtLeastOnce,
            DeliveryGuarantee::ExactlyOnce,
        ] {
            let stored = StoredDelivery::from(value.clone());
            assert_eq!(DeliveryGuarantee::from(stored), value);
        }
    }

    #[test]
    fn only_a_torn_final_record_is_ignored_during_recovery() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("inbox.log"), b"not-json\n").unwrap();
        assert!(DurableMqttStore::open_at(dir.path()).is_ok());

        std::fs::write(dir.path().join("inbox.log"), b"not-json\n{}\n").unwrap();
        let error = match DurableMqttStore::open_at(dir.path()) {
            Ok(_) => panic!("middle durable queue corruption must be reported"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}

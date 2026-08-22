//! Small append-only durable queues used by the MQTT supervisor.
//!
//! The queue is deliberately independent of the MQTT generation.  A worker
//! can therefore be rebuilt without losing messages that were accepted by the
//! daemon but had not reached the broker (or the business executor) yet.

use std::collections::{BTreeMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use teamclu_transport::{DeliveryGuarantee, IncomingFrame};

const COMPACT_AFTER_OPS: usize = 128;
const MAX_DURABLE_LOG_LINE_BYTES: usize = 8 * 1024 * 1024;
const DEAD_LETTER_MAX_ENTRIES: usize = 1024;
const DEAD_LETTER_MAX_BYTES: usize = 16 * 1024 * 1024;
const DEAD_LETTER_MAX_REASON_BYTES: usize = 4 * 1024;

struct DurableDedup {
    path: PathBuf,
    keys: HashSet<String>,
    ops_since_compact: usize,
}

#[derive(Debug, Serialize, Deserialize)]
enum DedupRecord {
    Insert { key: String },
    Remove { key: String },
}

impl DurableDedup {
    fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut keys = HashSet::new();
        if path.is_file() {
            for_each_log_line(&path, |line| {
                if line.trim().is_empty() {
                    return Ok(());
                }
                match serde_json::from_str::<DedupRecord>(line.trim()) {
                    Ok(DedupRecord::Insert { key }) => {
                        keys.insert(key);
                    }
                    Ok(DedupRecord::Remove { key }) => {
                        keys.remove(&key);
                    }
                    Err(record_error) => match serde_json::from_str::<String>(line.trim()) {
                        // Older builds wrote the key directly. Keep those
                        // records readable while the next compaction upgrades
                        // the file to the insert/remove format.
                        Ok(key) => {
                            keys.insert(key);
                        }
                        Err(legacy_error) if line.is_final => {
                            let error = format!("{record_error}; {legacy_error}");
                            truncate_torn_tail(&path, line.start)?;
                            tracing::warn!(path = %path.display(), %error, "ignoring torn final MQTT dedup record");
                        }
                        Err(legacy_error) => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!(
                                    "malformed durable MQTT dedup record at line {}: {record_error}; {legacy_error}",
                                    line.line_no
                                ),
                            ));
                        }
                    },
                }
                Ok(())
            })?;
        }
        Ok(Self {
            path,
            keys,
            ops_since_compact: 0,
        })
    }

    fn contains(&self, key: &str) -> bool {
        self.keys.contains(key)
    }

    fn insert(&mut self, key: String) -> io::Result<()> {
        if self.keys.contains(&key) {
            return Ok(());
        }
        self.append_record(&DedupRecord::Insert { key: key.clone() })?;
        self.keys.insert(key);
        self.compact_if_needed()
    }

    fn remove(&mut self, key: &str) -> io::Result<()> {
        if !self.keys.contains(key) {
            return Ok(());
        }
        self.append_record(&DedupRecord::Remove {
            key: key.to_string(),
        })?;
        self.keys.remove(key);
        self.compact_if_needed()
    }

    fn reconcile(&mut self, pending_keys: HashSet<String>) -> io::Result<()> {
        if self.keys == pending_keys {
            return Ok(());
        }
        self.keys = pending_keys;
        self.compact()
    }

    fn append_record(&mut self, record: &DedupRecord) -> io::Result<()> {
        let encoded = serde_json::to_vec(record)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if encoded.len() > MAX_DURABLE_LOG_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("durable MQTT dedup record exceeds {MAX_DURABLE_LOG_LINE_BYTES} bytes"),
            ));
        }
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

    fn compact_if_needed(&mut self) -> io::Result<()> {
        if self.ops_since_compact < COMPACT_AFTER_OPS
            || self.ops_since_compact < self.keys.len().max(1)
        {
            return Ok(());
        }
        self.compact()
    }

    fn compact(&mut self) -> io::Result<()> {
        let temp_path = self.path.with_extension("log.tmp");
        let result = (|| {
            let mut file = File::create(&temp_path)?;
            for key in &self.keys {
                let encoded = serde_json::to_vec(&DedupRecord::Insert { key: key.clone() })
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                file.write_all(&encoded)?;
                file.write_all(b"\n")?;
            }
            file.sync_all()?;
            std::fs::rename(&temp_path, &self.path)?;
            sync_parent_directory(self.path.parent())?;
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

#[derive(Debug, Serialize, Deserialize)]
enum LogRecord<T> {
    Put { id: u64, item: T },
    Ack { id: u64 },
    Watermark { next_id: u64 },
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
            for_each_log_line(&path, |line| {
                if line.trim().is_empty() {
                    return Ok(());
                }
                let record = match serde_json::from_str::<LogRecord<T>>(line.trim()) {
                    Ok(record) => record,
                    Err(error) if line.is_final => {
                        truncate_torn_tail(&path, line.start)?;
                        tracing::warn!(
                            path = %path.display(),
                            line = line.line_no,
                            %error,
                            "ignoring torn final durable MQTT queue record"
                        );
                        return Ok(());
                    }
                    Err(error) => {
                        // A process can be killed while appending the final
                        // line. Only that torn tail is recoverable. A
                        // malformed record with later records means the log
                        // is damaged in the middle and must not silently drop
                        // a durable message.
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!(
                                "malformed durable queue record at line {}: {}",
                                line.line_no, error
                            ),
                        ));
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
                    LogRecord::Watermark {
                        next_id: high_water_mark,
                    } => {
                        next_id = next_id.max(high_water_mark);
                    }
                }
                Ok(())
            })?;
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
        if encoded.len() > MAX_DURABLE_LOG_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("durable MQTT queue record exceeds {MAX_DURABLE_LOG_LINE_BYTES} bytes"),
            ));
        }
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
            let watermark = LogRecord::<T>::Watermark {
                next_id: self.next_id,
            };
            let encoded = serde_json::to_vec(&watermark)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            file.write_all(&encoded)?;
            file.write_all(b"\n")?;
            for (&id, item) in &self.entries {
                let record = LogRecord::Put { id, item };
                let encoded = serde_json::to_vec(&record)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                file.write_all(&encoded)?;
                file.write_all(b"\n")?;
            }
            file.sync_all()?;
            std::fs::rename(&temp_path, &self.path)?;
            sync_parent_directory(self.path.parent())?;
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

struct LogLine {
    line_no: usize,
    start: usize,
    text: String,
    is_final: bool,
}

impl LogLine {
    fn trim(&self) -> &str {
        self.text.trim()
    }
}

fn for_each_log_line(
    path: &Path,
    mut callback: impl FnMut(&LogLine) -> io::Result<()>,
) -> io::Result<()> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut line_start = 0_usize;
    let mut line_no = 1_usize;
    let mut offset = 0_usize;

    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            if line.is_empty() {
                break;
            }
            let text = String::from_utf8(std::mem::take(&mut line)).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid UTF-8 in durable log line {line_no}: {error}"),
                )
            })?;
            callback(&LogLine {
                line_no,
                start: line_start,
                text,
                is_final: true,
            })?;
            break;
        }

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |position| position + 1);
        if line.len().saturating_add(take) > MAX_DURABLE_LOG_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("durable log line {line_no} exceeds {MAX_DURABLE_LOG_LINE_BYTES} bytes"),
            ));
        }
        let has_newline = newline.is_some();
        let content_len = newline.unwrap_or(take);
        line.extend_from_slice(&buffer[..content_len]);
        reader.consume(take);
        offset = offset.saturating_add(take);

        if has_newline {
            let text = String::from_utf8(std::mem::take(&mut line)).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid UTF-8 in durable log line {line_no}: {error}"),
                )
            })?;
            let is_final = reader.fill_buf()?.is_empty();
            callback(&LogLine {
                line_no,
                start: line_start,
                text,
                is_final,
            })?;
            line_start = offset;
            line_no += 1;
        }
    }
    Ok(())
}

fn truncate_torn_tail(path: &Path, offset: usize) -> io::Result<()> {
    let file = OpenOptions::new().write(true).open(path)?;
    file.set_len(offset as u64)?;
    file.sync_data()
}

#[cfg(unix)]
fn sync_parent_directory(parent: Option<&Path>) -> io::Result<()> {
    let Some(parent) = parent else {
        return Ok(());
    };
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: Option<&Path>) -> io::Result<()> {
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DurableInbound {
    pub(crate) topic: String,
    pub(crate) payload: Vec<u8>,
    pub(crate) retained: bool,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DurablePublish {
    pub(crate) topic: String,
    pub(crate) payload: Vec<u8>,
    pub(crate) retain: bool,
    pub(crate) delivery: StoredDelivery,
    /// Optional protocol event id retained for diagnostics and downstream
    /// idempotency. The payload remains the source of truth for old records.
    #[serde(default)]
    pub(crate) event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DurableDeadLetter {
    pub(crate) inbound: DurableInbound,
    pub(crate) reason: String,
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
    dead_letter: DurableQueue<DurableDeadLetter>,
    inbound_dedup: DurableDedup,
}

impl DurableMqttStore {
    pub(crate) fn open_default() -> io::Result<Self> {
        Self::open_at(crate::config::layout::active_state_dir().join("mqtt"))
    }

    pub(crate) fn open_at(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        let inbox: DurableQueue<DurableInbound> = DurableQueue::open(dir.join("inbox.log"))?;
        let outbox: DurableQueue<DurablePublish> = DurableQueue::open(dir.join("outbox.log"))?;
        let dead_letter: DurableQueue<DurableDeadLetter> =
            DurableQueue::open(dir.join("dead-letter.log"))?;

        // A crash can leave the dead-letter Put durable while its inbox ACK is
        // still missing. Reconcile that terminal transition on reopen before
        // replaying the inbox, otherwise a poison message is executed again.
        let orphaned_inbox_ids = inbox
            .values()
            .filter(|(_, inbound)| {
                dead_letter
                    .values()
                    .any(|(_, item)| same_inbound(inbound, &item.inbound))
            })
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        let mut inbox = inbox;
        for id in orphaned_inbox_ids {
            inbox.ack(id)?;
        }
        let mut inbound_dedup = DurableDedup::open(dir.join("inbox-dedup.log"))?;

        // Rebuild the dedup index from pending inbox entries as well as its
        // append-only log. This closes the crash window between the inbox Put
        // record and the dedup record: a redelivery after that window must not
        // create a second durable item.
        let pending_keys = inbox
            .values()
            .filter_map(|(_, item)| {
                item.message_id
                    .as_ref()
                    .map(|message_id| format!("{}:{message_id}", item.topic))
            })
            .collect();
        // Deduplication is needed for messages that are still inside the
        // inbox. Keeping acknowledged ids forever turns this index into an
        // unbounded history and eventually becomes a disk/memory outage.
        // Reconcile from the inbox on every reopen so a crash between inbox
        // ACK and dedup removal also self-heals.
        inbound_dedup.reconcile(pending_keys)?;

        Ok(Self {
            inbox,
            outbox,
            dead_letter,
            inbound_dedup,
        })
    }

    pub(crate) fn enqueue_inbound(
        &mut self,
        frame: IncomingFrame,
        message_id: Option<String>,
    ) -> io::Result<Option<u64>> {
        let dedup_key = message_id
            .as_ref()
            .map(|id| format!("{}:{id}", frame.topic));
        if dedup_key
            .as_deref()
            .is_some_and(|key| self.inbound_dedup.contains(key))
        {
            return Ok(None);
        }
        if message_id.as_deref().is_some_and(|message_id| {
            self.inbox.values().any(|(_, inbound)| {
                inbound.topic == frame.topic && inbound.message_id.as_deref() == Some(message_id)
            })
        }) {
            return Ok(None);
        }
        let id = self.inbox.put(DurableInbound {
            topic: frame.topic,
            payload: frame.payload,
            retained: frame.retained,
            message_id,
        })?;
        if let Some(key) = dedup_key {
            self.inbound_dedup.insert(key)?;
        }
        Ok(Some(id))
    }

    pub(crate) fn ack_inbound(&mut self, id: u64) -> io::Result<()> {
        let dedup_key = self.inbox.get(id).and_then(|item| {
            item.message_id
                .as_ref()
                .map(|message_id| format!("{}:{message_id}", item.topic))
        });
        self.inbox.ack(id)?;
        if let Some(key) = dedup_key {
            self.inbound_dedup.remove(&key)?;
        }
        Ok(())
    }

    /// Persist a terminally rejected inbound before removing it from the
    /// retryable inbox. This keeps malformed or unauthorized messages
    /// inspectable without allowing one poison message to block recovery.
    pub(crate) fn dead_letter_inbound(&mut self, id: u64, reason: String) -> io::Result<()> {
        let Some(inbound) = self.inbox.get(id).cloned() else {
            return Ok(());
        };
        if self
            .dead_letter
            .values()
            .any(|(_, item)| same_inbound(&inbound, &item.inbound))
        {
            self.inbox.ack(id)?;
            if let Some(message_id) = inbound.message_id.as_ref() {
                self.inbound_dedup
                    .remove(&format!("{}:{message_id}", inbound.topic))?;
            }
            return Ok(());
        }
        let dead_letter = DurableDeadLetter {
            inbound,
            reason: truncate_reason(reason),
        };
        let incoming_bytes = dead_letter_bytes(&dead_letter);
        if incoming_bytes > DEAD_LETTER_MAX_BYTES {
            tracing::warn!(
                id,
                incoming_bytes,
                max_bytes = DEAD_LETTER_MAX_BYTES,
                "dropping oversized MQTT dead-letter item after durable inbox admission"
            );
            return self.ack_inbound(id);
        }
        while self.dead_letter.len() >= DEAD_LETTER_MAX_ENTRIES
            || self.dead_letter_bytes().saturating_add(incoming_bytes) > DEAD_LETTER_MAX_BYTES
        {
            let Some((oldest_id, _)) = self.dead_letter.values().next() else {
                break;
            };
            self.dead_letter.ack(oldest_id)?;
            tracing::warn!(
                oldest_id,
                max_entries = DEAD_LETTER_MAX_ENTRIES,
                max_bytes = DEAD_LETTER_MAX_BYTES,
                "evicted oldest MQTT dead-letter item"
            );
        }
        self.dead_letter.put(dead_letter)?;
        self.ack_inbound(id)
    }

    fn dead_letter_bytes(&self) -> usize {
        self.dead_letter
            .values()
            .map(|(_, item)| dead_letter_bytes(item))
            .sum()
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

    pub(crate) fn enqueue_publish(&mut self, mut publish: DurablePublish) -> io::Result<u64> {
        // The local queue id is an ordering cursor, not an event identity. A
        // UUID survives generation rebuilds and process restarts, so an
        // at-least-once consumer can deduplicate a replayed publish.
        if publish.event_id.is_none() {
            publish.event_id = Some(uuid::Uuid::new_v4().to_string());
        }
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

    #[cfg(test)]
    fn dead_letter_len(&self) -> usize {
        self.dead_letter.len()
    }
}

fn same_inbound(left: &DurableInbound, right: &DurableInbound) -> bool {
    left.topic == right.topic
        && left.payload == right.payload
        && left.retained == right.retained
        && left.message_id == right.message_id
}

fn dead_letter_bytes(item: &DurableDeadLetter) -> usize {
    item.inbound.topic.len()
        + item.inbound.payload.len()
        + item.reason.len()
        + item.inbound.message_id.as_ref().map_or(0, String::len)
}

fn truncate_reason(mut reason: String) -> String {
    if reason.len() <= DEAD_LETTER_MAX_REASON_BYTES {
        return reason;
    }
    let mut end = DEAD_LETTER_MAX_REASON_BYTES.saturating_sub(3);
    while !reason.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    reason.truncate(end);
    reason.push_str("...");
    reason
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
            inbound_id = store
                .enqueue_inbound(frame.clone(), Some("message-1".to_string()))
                .unwrap()
                .unwrap();
            outbound_id = store
                .enqueue_publish(DurablePublish {
                    topic: "amux/team/actor/state".into(),
                    payload: vec![4, 5],
                    retain: true,
                    delivery: StoredDelivery::AtLeastOnce,
                    event_id: Some("event-1".into()),
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
    fn replay_preserves_fifo_ids_and_outbox_event_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        let first = store
            .enqueue_inbound(
                IncomingFrame {
                    topic: "amux/team/actor/notify".into(),
                    payload: vec![1],
                    retained: false,
                },
                Some("in-1".into()),
            )
            .unwrap()
            .unwrap();
        let second = store
            .enqueue_inbound(
                IncomingFrame {
                    topic: "amux/team/actor/notify".into(),
                    payload: vec![2],
                    retained: false,
                },
                Some("in-2".into()),
            )
            .unwrap()
            .unwrap();
        let third = store
            .enqueue_inbound(
                IncomingFrame {
                    topic: "amux/team/actor/notify".into(),
                    payload: vec![3],
                    retained: false,
                },
                Some("in-3".into()),
            )
            .unwrap()
            .unwrap();
        store.ack_inbound(second).unwrap();

        let outbox_id = store
            .enqueue_publish(DurablePublish {
                topic: "amux/team/actor/state".into(),
                payload: vec![7],
                retain: true,
                delivery: StoredDelivery::AtLeastOnce,
                event_id: None,
            })
            .unwrap();
        let event_id = store.outbox(outbox_id).unwrap().event_id.clone();
        assert!(event_id.is_some());

        let reopened = DurableMqttStore::open_at(dir.path()).unwrap();
        assert_eq!(
            reopened
                .pending_inbound()
                .map(|(id, _)| id)
                .collect::<Vec<_>>(),
            vec![first, third]
        );
        assert_eq!(reopened.outbox(outbox_id).unwrap().event_id, event_id);
    }

    #[test]
    fn pending_inbox_rebuilds_dedup_after_put_before_dedup_crash_window() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = LogRecord::Put {
            id: 1,
            item: DurableInbound {
                topic: "amux/team/actor/notify".into(),
                payload: vec![8],
                retained: false,
                message_id: Some("crash-window-1".into()),
            },
        };
        std::fs::write(
            dir.path().join("inbox.log"),
            format!("{}\n", serde_json::to_string(&inbox).unwrap()),
        )
        .unwrap();

        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        let duplicate = store
            .enqueue_inbound(
                IncomingFrame {
                    topic: "amux/team/actor/notify".into(),
                    payload: vec![8],
                    retained: false,
                },
                Some("crash-window-1".into()),
            )
            .unwrap();
        assert_eq!(duplicate, None);
        assert_eq!(store.inbound_len(), 1);
    }

    #[test]
    fn ack_compacts_log_without_changing_recovered_entries() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        let mut ids = Vec::new();
        for value in 0..130u8 {
            ids.push(
                store
                    .enqueue_inbound(
                        IncomingFrame {
                            topic: "amux/team/actor/notify".into(),
                            payload: vec![value],
                            retained: false,
                        },
                        Some(format!("compact-{value}")),
                    )
                    .unwrap()
                    .unwrap(),
            );
        }
        for id in ids {
            store.ack_inbound(id).unwrap();
        }

        let log_len = std::fs::metadata(dir.path().join("inbox.log"))
            .unwrap()
            .len();
        assert!(log_len < 256, "ACK compaction did not shrink the log");
        assert_eq!(
            DurableMqttStore::open_at(dir.path()).unwrap().inbound_len(),
            0
        );
    }

    #[test]
    fn queue_compaction_preserves_high_water_mark_for_late_acks() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        let mut last_id = 0;
        for value in 0..64u8 {
            let id = store
                .enqueue_inbound(
                    IncomingFrame {
                        topic: "amux/team/actor/notify".into(),
                        payload: vec![value],
                        retained: false,
                    },
                    Some(format!("watermark-{value}")),
                )
                .unwrap()
                .unwrap();
            last_id = id;
            store.ack_inbound(id).unwrap();
        }

        let mut reopened = DurableMqttStore::open_at(dir.path()).unwrap();
        let new_id = reopened
            .enqueue_inbound(
                IncomingFrame {
                    topic: "amux/team/actor/notify".into(),
                    payload: vec![99],
                    retained: false,
                },
                Some("watermark-new".into()),
            )
            .unwrap()
            .unwrap();
        assert!(new_id > last_id);
        // An ACK from the old generation must not be able to target this item.
        reopened.ack_inbound(last_id).unwrap();
        assert!(reopened.inbound(new_id).is_some());
    }

    #[test]
    fn acknowledged_inbound_ids_do_not_grow_the_dedup_log_forever() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        for value in 0..128u16 {
            let id = store
                .enqueue_inbound(
                    IncomingFrame {
                        topic: "amux/team/actor/notify".into(),
                        payload: value.to_le_bytes().to_vec(),
                        retained: false,
                    },
                    Some(format!("dedup-compact-{value}")),
                )
                .unwrap()
                .unwrap();
            store.ack_inbound(id).unwrap();
        }

        let dedup_path = dir.path().join("inbox-dedup.log");
        assert!(
            std::fs::metadata(&dedup_path).unwrap().len() < 256,
            "acknowledged dedup ids must be compacted"
        );
        assert_eq!(store.inbound_len(), 0);
        assert_eq!(
            DurableMqttStore::open_at(dir.path()).unwrap().inbound_len(),
            0
        );
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
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        let id = store
            .enqueue_inbound(
                IncomingFrame {
                    topic: "amux/team/actor/notify".into(),
                    payload: vec![1],
                    retained: false,
                },
                Some("after-torn-tail".into()),
            )
            .unwrap()
            .unwrap();
        let reopened = DurableMqttStore::open_at(dir.path()).unwrap();
        assert!(reopened.inbound(id).is_some());

        std::fs::write(dir.path().join("inbox.log"), b"not-json\n{}\n").unwrap();
        let error = match DurableMqttStore::open_at(dir.path()) {
            Ok(_) => panic!("middle durable queue corruption must be reported"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn torn_tail_truncation_preserves_records_spanning_reader_buffers() {
        let dir = tempfile::tempdir().unwrap();
        let first = LogRecord::Put {
            id: 1,
            item: DurableInbound {
                topic: "amux/team/actor/notify".into(),
                payload: vec![7; 10_000],
                retained: false,
                message_id: Some("large-record".into()),
            },
        };
        let first_line = format!("{}\n", serde_json::to_string(&first).unwrap());
        let mut contents = first_line.as_bytes().to_vec();
        contents.extend_from_slice(b"{\"Put\":{\"id\":2,\"item\":");
        std::fs::write(dir.path().join("inbox.log"), contents).unwrap();

        let reopened = DurableMqttStore::open_at(dir.path()).unwrap();
        assert_eq!(reopened.inbound_len(), 1);
        assert_eq!(reopened.inbound(1).unwrap().payload.len(), 10_000);
        assert_eq!(
            std::fs::metadata(dir.path().join("inbox.log"))
                .unwrap()
                .len(),
            first_line.len() as u64
        );
    }

    #[test]
    fn stable_redelivery_is_deduplicated_but_unidentified_messages_are_not() {
        let dir = tempfile::tempdir().unwrap();
        let frame = IncomingFrame {
            topic: "amux/team/actor/notify".into(),
            payload: vec![1],
            retained: false,
        };
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        assert!(store
            .enqueue_inbound(frame.clone(), Some("m-1".into()))
            .unwrap()
            .is_some());
        assert!(store
            .enqueue_inbound(frame.clone(), Some("m-1".into()))
            .unwrap()
            .is_none());
        assert!(store.enqueue_inbound(frame, None).unwrap().is_some());
        assert_eq!(store.inbound_len(), 2);
    }

    #[test]
    fn permanent_inbound_failure_is_durable_before_inbox_ack() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        let id = store
            .enqueue_inbound(
                IncomingFrame {
                    topic: "amux/team/actor/notify".into(),
                    payload: vec![9],
                    retained: false,
                },
                Some("poison-1".into()),
            )
            .unwrap()
            .unwrap();
        store
            .dead_letter_inbound(id, "invalid payload".into())
            .unwrap();
        assert_eq!(store.inbound_len(), 0);
        assert_eq!(store.dead_letter_len(), 1);
        let reopened = DurableMqttStore::open_at(dir.path()).unwrap();
        assert_eq!(reopened.inbound_len(), 0);
        assert_eq!(reopened.dead_letter_len(), 1);
    }

    #[test]
    fn dead_letter_retention_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        for value in 0..=DEAD_LETTER_MAX_ENTRIES {
            let id = store
                .enqueue_inbound(
                    IncomingFrame {
                        topic: "amux/team/actor/notify".into(),
                        payload: value.to_le_bytes().to_vec(),
                        retained: false,
                    },
                    Some(format!("dead-letter-{value}")),
                )
                .unwrap()
                .unwrap();
            store
                .dead_letter_inbound(id, "poison message".repeat(2_000))
                .unwrap();
        }

        assert_eq!(store.dead_letter_len(), DEAD_LETTER_MAX_ENTRIES);
        assert!(
            std::fs::metadata(dir.path().join("dead-letter.log"))
                .unwrap()
                .len()
                <= (DEAD_LETTER_MAX_BYTES as u64 * 2),
            "dead-letter log must remain bounded between compactions"
        );
    }

    #[test]
    fn dedup_torn_tail_is_recoverable_but_middle_corruption_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("inbox-dedup.log");
        std::fs::write(&path, b"\"ok\"\n\"torn").unwrap();
        let mut store = DurableMqttStore::open_at(dir.path()).unwrap();
        assert!(store.inbound_len() == 0);
        store
            .enqueue_inbound(
                IncomingFrame {
                    topic: "amux/team/actor/notify".into(),
                    payload: vec![2],
                    retained: false,
                },
                Some("after-dedup-tail".into()),
            )
            .unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("torn"));

        std::fs::write(&path, b"\"ok\"\nnot-json\n\"later\"\n").unwrap();
        let error = match DurableMqttStore::open_at(dir.path()) {
            Ok(_) => panic!("middle dedup corruption must be reported"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn reopen_reconciles_a_dead_letter_put_without_its_inbox_ack() {
        let dir = tempfile::tempdir().unwrap();
        let inbound = DurableInbound {
            topic: "amux/team/actor/notify".into(),
            payload: vec![3],
            retained: false,
            message_id: Some("poison-crash-1".into()),
        };
        std::fs::write(
            dir.path().join("inbox.log"),
            format!(
                "{}\n",
                serde_json::to_string(&LogRecord::Put {
                    id: 1,
                    item: inbound.clone(),
                })
                .unwrap()
            ),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("dead-letter.log"),
            format!(
                "{}\n",
                serde_json::to_string(&LogRecord::Put {
                    id: 1,
                    item: DurableDeadLetter {
                        inbound,
                        reason: "poison".into(),
                    },
                })
                .unwrap()
            ),
        )
        .unwrap();

        let store = DurableMqttStore::open_at(dir.path()).unwrap();
        assert_eq!(store.inbound_len(), 0);
        assert_eq!(store.dead_letter_len(), 1);
    }
}

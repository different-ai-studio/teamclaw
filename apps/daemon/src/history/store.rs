use prost::Message;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::warn;

use crate::proto::amux::Envelope;

/// Disk-backed event history per agent.
/// Events are append-only files: `{dir}/{agent_id}.bin`
/// Each entry: [4-byte big-endian length][protobuf bytes]
pub struct EventHistory {
    dir: PathBuf,
    /// In-memory index: agent_id -> vec of (sequence, file_offset)
    index: HashMap<String, Vec<(u64, u64)>>,
}

impl EventHistory {
    pub fn new(dir: &Path) -> Self {
        std::fs::create_dir_all(dir).ok();
        Self {
            dir: dir.to_path_buf(),
            index: HashMap::new(),
        }
    }

    fn agent_path(&self, agent_id: &str) -> PathBuf {
        // Sanitize agent_id for filesystem
        let safe = agent_id.replace(['/', '\\', '.'], "_");
        self.dir.join(format!("{}.bin", safe))
    }

    /// Append an envelope to disk. Returns the sequence number stored.
    pub fn append(&mut self, agent_id: &str, envelope: &Envelope) {
        use std::io::Write;
        let path = self.agent_path(agent_id);
        let offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let bytes = envelope.encode_to_vec();
        let len = bytes.len() as u32;

        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(mut f) => {
                if f.write_all(&len.to_be_bytes()).is_ok() && f.write_all(&bytes).is_ok() {
                    let idx = self.index.entry(agent_id.to_string()).or_default();
                    idx.push((envelope.sequence, offset));
                }
            }
            Err(e) => warn!("history write failed for {}: {}", agent_id, e),
        }
    }

    /// Read events for an agent with sequence > after_sequence, up to page_size.
    /// Returns (events, has_more).
    pub fn read_page(
        &mut self,
        agent_id: &str,
        after_sequence: u64,
        page_size: u32,
    ) -> (Vec<Envelope>, bool) {
        // Ensure index is loaded
        if !self.index.contains_key(agent_id) {
            self.load_index(agent_id);
        }

        let idx = match self.index.get(agent_id) {
            Some(idx) => idx,
            None => return (vec![], false),
        };

        // Find entries after the requested sequence
        let start = idx.partition_point(|(seq, _)| *seq <= after_sequence);
        let page = page_size.max(1) as usize;
        let end = (start + page).min(idx.len());
        let has_more = end < idx.len();

        if start >= idx.len() {
            return (vec![], false);
        }

        // Read the entries from disk
        let path = self.agent_path(agent_id);
        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(_) => return (vec![], false),
        };

        let mut events = Vec::with_capacity(end - start);
        for &(_, offset) in &idx[start..end] {
            let off = offset as usize;
            if off + 4 > data.len() {
                break;
            }
            let len = u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
                as usize;
            if off + 4 + len > data.len() {
                break;
            }
            if let Ok(env) = Envelope::decode(&data[off + 4..off + 4 + len]) {
                events.push(env);
            }
        }

        (events, has_more)
    }

    /// Read all envelopes for a specific turn from one agent's history.
    /// Used by `AcpRequestTurnHistory` — iOS opens a turn detail or resumes
    /// mid-turn streaming and wants every Thinking / ToolCall / Output /
    /// StatusChange event tagged with `turn_id`. Linear scan of the agent's
    /// index — turns are short (tens to low hundreds of events) so we don't
    /// keep a secondary turn_id → offsets index.
    pub fn read_turn(&mut self, agent_id: &str, turn_id: &str) -> Vec<Envelope> {
        if turn_id.is_empty() {
            return vec![];
        }
        if !self.index.contains_key(agent_id) {
            self.load_index(agent_id);
        }
        let idx = match self.index.get(agent_id) {
            Some(idx) => idx.clone(),
            None => return vec![],
        };
        let path = self.agent_path(agent_id);
        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(_) => return vec![],
        };
        let mut out = Vec::new();
        for &(_, offset) in &idx {
            let off = offset as usize;
            if off + 4 > data.len() {
                break;
            }
            let len = u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]])
                as usize;
            if off + 4 + len > data.len() {
                break;
            }
            if let Ok(env) = Envelope::decode(&data[off + 4..off + 4 + len]) {
                if env.turn_id == turn_id {
                    out.push(env);
                }
            }
        }
        out
    }

    /// Load index from disk by scanning the file.
    fn load_index(&mut self, agent_id: &str) {
        let path = self.agent_path(agent_id);
        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(_) => return,
        };

        let mut idx = Vec::new();
        let mut pos = 0usize;
        while pos + 4 <= data.len() {
            let len = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            if pos + 4 + len > data.len() {
                break;
            }
            if let Ok(env) = Envelope::decode(&data[pos + 4..pos + 4 + len]) {
                idx.push((env.sequence, pos as u64));
            }
            pos += 4 + len;
        }

        self.index.insert(agent_id.to_string(), idx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux::Envelope;

    fn env(seq: u64, turn_id: &str) -> Envelope {
        Envelope {
            runtime_id: "agent".into(),
            actor_id: "actor".into(),
            source_peer_id: String::new(),
            timestamp: 0,
            sequence: seq,
            turn_id: turn_id.into(),
            acp_session_id: String::new(),
            payload: None,
        }
    }

    #[test]
    fn read_turn_returns_only_matching_turn() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = EventHistory::new(tmp.path());

        let turn_a = "00000000-0000-0000-0000-00000000000a";
        let turn_b = "00000000-0000-0000-0000-00000000000b";

        store.append("agent", &env(1, turn_a));
        store.append("agent", &env(2, turn_a));
        store.append("agent", &env(3, turn_b));
        store.append("agent", &env(4, turn_a));
        store.append("agent", &env(5, "")); // empty turn (status_change at idle)

        let got = store.read_turn("agent", turn_a);
        let seqs: Vec<u64> = got.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs, vec![1, 2, 4]);
    }

    #[test]
    fn read_turn_empty_turn_id_returns_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = EventHistory::new(tmp.path());
        store.append("agent", &env(1, "abc"));
        assert!(store.read_turn("agent", "").is_empty());
    }

    #[test]
    fn read_turn_unknown_agent_returns_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = EventHistory::new(tmp.path());
        store.append("agent", &env(1, "abc"));
        assert!(store.read_turn("other-agent", "abc").is_empty());
    }
}

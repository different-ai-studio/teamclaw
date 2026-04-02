use std::collections::HashMap;
use std::path::PathBuf;

use tracing::{info, warn};

// ─── BoardType ────────────────────────────────────────────────────────────────

/// The set of Loro CRDT documents that make up the shared blackboard.
/// Phase 1: `Registry`. Phase 2: `TaskBoard`. Phase 3: `Knowledge`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BoardType {
    Registry,
    TaskBoard,
    Knowledge,
}

impl BoardType {
    /// The key used in `HashMap` lookups and log messages.
    pub fn key(&self) -> &'static str {
        match self {
            BoardType::Registry => "registry",
            BoardType::TaskBoard => "task_board",
            BoardType::Knowledge => "knowledge",
        }
    }

    /// The filename for the on-disk snapshot (without directory).
    pub fn snapshot_filename(&self) -> String {
        format!("{}.snapshot", self.key())
    }
}

// ─── Blackboard ───────────────────────────────────────────────────────────────

/// Manages Loro CRDT documents that form the shared agent state.
pub struct Blackboard {
    /// One LoroDoc per board type.
    docs: HashMap<BoardType, loro::LoroDoc>,
    /// The version vector at the time of the last `export_updates` call.
    /// Used to produce incremental update payloads.
    last_exported_version: HashMap<BoardType, Vec<u8>>,
    /// Directory where snapshots are persisted.
    storage_path: PathBuf,
}

impl Blackboard {
    /// Create a new `Blackboard`, loading any existing snapshots from `storage_path`.
    pub fn new(storage_path: PathBuf) -> Self {
        let mut docs: HashMap<BoardType, loro::LoroDoc> = HashMap::new();
        let last_exported_version: HashMap<BoardType, Vec<u8>> = HashMap::new();

        // Initialise every known board type.
        let board_types = [BoardType::Registry, BoardType::TaskBoard, BoardType::Knowledge];
        for bt in &board_types {
            let doc = loro::LoroDoc::new();
            let snapshot_path = storage_path.join(bt.snapshot_filename());
            if snapshot_path.exists() {
                match std::fs::read(&snapshot_path) {
                    Ok(data) => {
                        if let Err(e) = doc.import(&data) {
                            warn!(
                                "Failed to import loro snapshot for {:?}: {e}",
                                bt.key()
                            );
                        } else {
                            info!("Loaded blackboard snapshot for {:?}", bt.key());
                        }
                    }
                    Err(e) => {
                        warn!(
                            "Could not read snapshot file {}: {e}",
                            snapshot_path.display()
                        );
                    }
                }
            }
            docs.insert(*bt, doc);
        }

        Self {
            docs,
            last_exported_version,
            storage_path,
        }
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    /// Immutable access to a doc.
    pub fn get_doc(&self, board: BoardType) -> Option<&loro::LoroDoc> {
        self.docs.get(&board)
    }

    /// Mutable access to a doc.
    pub fn get_doc_mut(&mut self, board: BoardType) -> Option<&mut loro::LoroDoc> {
        self.docs.get_mut(&board)
    }

    // ── Incremental export / import ───────────────────────────────────────────

    /// Export updates since the last call to this method for `board`.
    ///
    /// Returns `None` when there is nothing new to export (i.e. the document
    /// has not changed since the previous call).
    pub fn export_updates(&mut self, board: BoardType) -> Option<Vec<u8>> {
        let doc = self.docs.get(&board)?;
        let current_vv = doc.oplog_vv();
        let current_vv_bytes = current_vv.encode();

        if let Some(prev_vv_bytes) = self.last_exported_version.get(&board) {
            // If the version vector hasn't changed there is nothing new.
            if prev_vv_bytes == &current_vv_bytes {
                return None;
            }

            // Incremental: only changes since the last export.
            let data = match loro::VersionVector::decode(prev_vv_bytes) {
                Ok(prev_vv) => doc
                    .export(loro::ExportMode::updates(&prev_vv))
                    .unwrap_or_else(|_| {
                        doc.export(loro::ExportMode::all_updates())
                            .unwrap_or_default()
                    }),
                Err(e) => {
                    warn!("Could not decode previous VersionVector: {e}");
                    doc.export(loro::ExportMode::all_updates()).ok()?
                }
            };

            self.last_exported_version.insert(board, current_vv_bytes);
            Some(data)
        } else {
            // First export: send everything.
            let data = doc.export(loro::ExportMode::all_updates()).ok()?;
            self.last_exported_version.insert(board, current_vv_bytes);
            Some(data)
        }
    }

    /// Import an update payload (produced by `export_updates` on another peer) into `board`.
    pub fn import_updates(&mut self, board: BoardType, data: &[u8]) -> Result<(), String> {
        let doc = self
            .docs
            .get_mut(&board)
            .ok_or_else(|| format!("Unknown board type: {:?}", board.key()))?;
        doc.import(data)
            .map_err(|e| format!("Failed to import updates for {:?}: {e}", board.key()))?;
        Ok(())
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    /// Write a snapshot of every board to `storage_path`.
    pub fn save_snapshots(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.storage_path).map_err(|e| {
            format!(
                "Failed to create storage dir {}: {e}",
                self.storage_path.display()
            )
        })?;

        for (bt, doc) in &self.docs {
            let snapshot = doc
                .export(loro::ExportMode::Snapshot)
                .map_err(|e| format!("Failed to export snapshot for {:?}: {e}", bt.key()))?;
            let path = self.storage_path.join(bt.snapshot_filename());
            std::fs::write(&path, &snapshot).map_err(|e| {
                format!("Failed to write snapshot {}: {e}", path.display())
            })?;
            info!("Saved blackboard snapshot for {:?}", bt.key());
        }
        Ok(())
    }

    // ── iroh-docs sync ────────────────────────────────────────────────────────

    /// Write the current state of `board` into an iroh-docs document.
    ///
    /// The snapshot bytes are stored under the key `<board.key()>/snapshot`.
    #[cfg(feature = "p2p")]
    pub async fn sync_to_iroh_doc(
        &self,
        board: BoardType,
        doc: &iroh_docs::api::Doc,
        author: iroh_docs::AuthorId,
    ) -> Result<(), String> {
        let loro_doc = self
            .docs
            .get(&board)
            .ok_or_else(|| format!("Unknown board type: {:?}", board.key()))?;

        let snapshot = loro_doc
            .export(loro::ExportMode::Snapshot)
            .map_err(|e| format!("Failed to export snapshot for sync: {e}"))?;

        let key = format!("{}/snapshot", board.key());
        doc.set_bytes(author, key, snapshot)
            .await
            .map_err(|e| format!("Failed to write to iroh-doc: {e}"))?;

        Ok(())
    }

    /// Read the state of `board` from an iroh-docs document and import it.
    ///
    /// Content is read via the blobs store passed alongside the doc.
    #[cfg(feature = "p2p")]
    pub async fn sync_from_iroh_doc(
        &mut self,
        board: BoardType,
        doc: &iroh_docs::api::Doc,
        blobs: &iroh_blobs::api::Store,
    ) -> Result<(), String> {
        use futures_lite::StreamExt;
        use std::pin::pin;

        let key = format!("{}/snapshot", board.key());
        let query = iroh_docs::store::Query::single_latest_per_key().build();
        let entries = doc
            .get_many(query)
            .await
            .map_err(|e| format!("Failed to query iroh-doc: {e}"))?;
        let mut entries = pin!(entries);

        while let Some(entry) = entries.next().await {
            let entry = entry.map_err(|e| format!("Entry error: {e}"))?;
            let entry_key = String::from_utf8_lossy(entry.key()).to_string();
            if entry_key != key {
                continue;
            }
            let content = blobs
                .blobs()
                .get_bytes(entry.content_hash())
                .await
                .map_err(|e| format!("Failed to read content from blobs: {e}"))?;
            self.import_updates(board, &content)?;
            return Ok(());
        }

        info!("No iroh-doc entry found for board {:?}", board.key());
        Ok(())
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // 1. Verify that a freshly created Blackboard has the Registry doc initialised.
    #[test]
    fn new_blackboard_initializes_registry_doc() {
        let dir = tempdir().expect("tempdir");
        let bb = Blackboard::new(dir.path().to_path_buf());
        assert!(
            bb.get_doc(BoardType::Registry).is_some(),
            "Registry doc should be present after construction"
        );
    }

    // 2. Write a value into the LoroMap "agents" and read it back.
    #[test]
    fn write_and_read_registry_entry() {
        let dir = tempdir().expect("tempdir");
        let mut bb = Blackboard::new(dir.path().to_path_buf());

        {
            let doc = bb.get_doc_mut(BoardType::Registry).unwrap();
            let map = doc.get_map("agents");
            map.insert("agent-1", "active").expect("insert");
        }

        let doc = bb.get_doc(BoardType::Registry).unwrap();
        let map = doc.get_map("agents");
        let value = map.get("agent-1");
        assert!(value.is_some(), "key should be present");
        if let Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s))) = value {
            assert_eq!(s.as_ref(), "active");
        } else {
            panic!("unexpected value type: {:?}", value);
        }
    }

    // 3. After exporting with no further changes, the second export returns None.
    #[test]
    fn export_updates_returns_none_when_no_changes() {
        let dir = tempdir().expect("tempdir");
        let mut bb = Blackboard::new(dir.path().to_path_buf());

        // Write something so there is at least one op.
        {
            let doc = bb.get_doc_mut(BoardType::Registry).unwrap();
            doc.get_map("agents").insert("x", "y").expect("insert");
        }

        let first = bb.export_updates(BoardType::Registry);
        assert!(first.is_some(), "first export should have data");

        let second = bb.export_updates(BoardType::Registry);
        assert!(second.is_none(), "second export with no new changes should be None");
    }

    // 4. bb1 writes data, exports; bb2 imports and can read the data.
    #[test]
    fn export_then_import_syncs_data() {
        let dir1 = tempdir().expect("tempdir 1");
        let dir2 = tempdir().expect("tempdir 2");

        let mut bb1 = Blackboard::new(dir1.path().to_path_buf());
        let mut bb2 = Blackboard::new(dir2.path().to_path_buf());

        {
            let doc = bb1.get_doc_mut(BoardType::Registry).unwrap();
            doc.get_map("agents").insert("agent-a", "running").expect("insert");
        }

        let updates = bb1
            .export_updates(BoardType::Registry)
            .expect("should have updates");

        bb2.import_updates(BoardType::Registry, &updates)
            .expect("import should succeed");

        let doc2 = bb2.get_doc(BoardType::Registry).unwrap();
        let map = doc2.get_map("agents");
        let value = map.get("agent-a");
        assert!(value.is_some(), "imported key should be visible in bb2");
        if let Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s))) = value {
            assert_eq!(s.as_ref(), "running");
        } else {
            panic!("unexpected value type: {:?}", value);
        }
    }

    // 5. Two peers write concurrently; after exchanging updates both see both entries.
    #[test]
    fn concurrent_writes_merge_via_crdt() {
        let dir1 = tempdir().expect("tempdir 1");
        let dir2 = tempdir().expect("tempdir 2");

        let mut bb1 = Blackboard::new(dir1.path().to_path_buf());
        let mut bb2 = Blackboard::new(dir2.path().to_path_buf());

        // Independent writes on each peer.
        {
            let doc = bb1.get_doc_mut(BoardType::Registry).unwrap();
            doc.get_map("agents").insert("peer1-agent", "online").expect("insert");
        }
        {
            let doc = bb2.get_doc_mut(BoardType::Registry).unwrap();
            doc.get_map("agents").insert("peer2-agent", "idle").expect("insert");
        }

        // Exchange updates.
        let u1 = bb1.export_updates(BoardType::Registry).expect("bb1 updates");
        let u2 = bb2.export_updates(BoardType::Registry).expect("bb2 updates");

        bb1.import_updates(BoardType::Registry, &u2).expect("bb1 import");
        bb2.import_updates(BoardType::Registry, &u1).expect("bb2 import");

        // Both peers should now see both entries.
        for (label, bb) in [("bb1", &bb1), ("bb2", &bb2)] {
            let map = bb.get_doc(BoardType::Registry).unwrap().get_map("agents");
            assert!(
                map.get("peer1-agent").is_some(),
                "{label} should see peer1-agent"
            );
            assert!(
                map.get("peer2-agent").is_some(),
                "{label} should see peer2-agent"
            );
        }
    }

    // 6. Write data, save snapshots, reload from same directory, verify data survives.
    #[test]
    fn save_and_reload_snapshot() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().to_path_buf();

        {
            let mut bb = Blackboard::new(path.clone());
            let doc = bb.get_doc_mut(BoardType::Registry).unwrap();
            doc.get_map("agents")
                .insert("persisted-agent", "healthy")
                .expect("insert");
            bb.save_snapshots().expect("save snapshots");
        }

        // Reload from the same directory.
        let bb2 = Blackboard::new(path);
        let map = bb2.get_doc(BoardType::Registry).unwrap().get_map("agents");
        let value = map.get("persisted-agent");
        assert!(value.is_some(), "persisted entry should survive reload");
        if let Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s))) = value {
            assert_eq!(s.as_ref(), "healthy");
        } else {
            panic!("unexpected value type after reload: {:?}", value);
        }
    }
}

//! Single owner for read-modify-write of a workspace's `opencode.json`.
//!
//! All amuxd-side writers acquire the per-path lock and use atomic replace
//! through this module so concurrent tasks cannot leave stale JSON tails.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tracing::warn;

use crate::atomic_write;

pub const OPENCODE_JSON: &str = "opencode.json";
/// Resolved config used while a runtime is active (secrets substituted).
pub const RUNTIME_OVERLAY_REL: &str = ".teamclaw/opencode.runtime.json";

#[derive(Debug, thiserror::Error)]
pub enum OpencodeConfigError {
    #[error("io: {0}")]
    Io(String),
    #[error("parse: {0}")]
    Parse(String),
}

pub fn opencode_config_path(workspace: &Path) -> PathBuf {
    workspace.join(OPENCODE_JSON)
}

pub fn runtime_overlay_path(workspace: &Path) -> PathBuf {
    workspace.join(RUNTIME_OVERLAY_REL)
}

pub struct OpencodeConfigStore;

impl OpencodeConfigStore {
    /// Load `opencode.json` as a JSON object, recovering a leading object when
    /// trailing garbage is present (non-atomic partial writes).
    pub fn load(workspace: &Path) -> Result<Value, OpencodeConfigError> {
        let path = opencode_config_path(workspace);
        if !path.exists() {
            return Ok(Value::Object(Default::default()));
        }
        let content = std::fs::read_to_string(&path).map_err(|e| OpencodeConfigError::Io(e.to_string()))?;
        match serde_json::from_str::<Value>(&content) {
            Ok(value) => Ok(value),
            Err(err) => Self::recover_leading_object(&path, &content, err),
        }
    }

    /// Raw file bytes when the file exists.
    pub fn load_raw(workspace: &Path) -> Result<Option<String>, OpencodeConfigError> {
        let path = opencode_config_path(workspace);
        if !path.exists() {
            return Ok(None);
        }
        std::fs::read_to_string(&path)
            .map_err(map_io_err)
            .map(Some)
    }

    /// Read-modify-write under the workspace write lock. The mutator returns
    /// `Ok(true)` when the in-memory value changed and should be persisted.
    pub fn apply<F>(workspace: &Path, mutator: F) -> Result<bool, OpencodeConfigError>
    where
        F: FnOnce(&mut Value) -> Result<bool, OpencodeConfigError>,
    {
        let path = opencode_config_path(workspace);
        let write_lock = atomic_write::opencode_write_lock(&path);
        let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = Self::load(workspace)?;
        if !mutator(&mut config)? {
            return Ok(false);
        }
        Self::write_value_at(&path, &config)?;
        Ok(true)
    }

    pub fn write_value(workspace: &Path, value: &Value) -> Result<(), OpencodeConfigError> {
        let path = opencode_config_path(workspace);
        let write_lock = atomic_write::opencode_write_lock(&path);
        let _guard = write_lock.lock().unwrap_or_else(|e| e.into_inner());
        Self::write_value_at(&path, value)
    }

    pub fn write_raw(path: &Path, content: &str) -> Result<(), OpencodeConfigError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(map_io_err)?;
        }
        atomic_write::atomic_write(path, content).map_err(map_io_err)
    }

    fn write_value_at(path: &Path, value: &Value) -> Result<(), OpencodeConfigError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(map_io_err)?;
        }
        let mut content =
            serde_json::to_string_pretty(value).map_err(|e| OpencodeConfigError::Parse(e.to_string()))?;
        if !content.ends_with('\n') {
            content.push('\n');
        }
        atomic_write::atomic_write(path, &content).map_err(map_io_err)
    }

    fn recover_leading_object(
        path: &Path,
        content: &str,
        original_err: serde_json::Error,
    ) -> Result<Value, OpencodeConfigError> {
        let mut stream = serde_json::Deserializer::from_str(content).into_iter::<Value>();
        let recovered = match stream.next() {
            Some(Ok(value)) if value.is_object() => value,
            _ => return Err(OpencodeConfigError::Parse(original_err.to_string())),
        };

        let backup = path.with_extension("json.corrupt.bak");
        if let Err(e) = std::fs::write(&backup, content) {
            warn!(
                path = %path.display(),
                error = %e,
                "opencode_config: failed to back up corrupt config; leaving file untouched"
            );
            return Ok(recovered);
        }

        match serde_json::to_string_pretty(&recovered) {
            Ok(clean) => {
                if let Err(e) = atomic_write::atomic_write(path, &format!("{clean}\n")) {
                    warn!(
                        path = %path.display(),
                        error = %e,
                        "opencode_config: failed to rewrite recovered config"
                    );
                } else {
                    warn!(
                        path = %path.display(),
                        backup = %backup.display(),
                        "opencode_config: recovered corrupt config (trailing bytes dropped); backup saved"
                    );
                }
            }
            Err(e) => warn!(
                path = %path.display(),
                error = %e,
                "opencode_config: could not re-serialize recovered config"
            ),
        }

        Ok(recovered)
    }
}

fn map_io_err(e: std::io::Error) -> OpencodeConfigError {
    OpencodeConfigError::Io(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn apply_persists_mutated_object_once() {
        let dir = tempfile::tempdir().unwrap();
        OpencodeConfigStore::apply(dir.path(), |cfg| {
            cfg.as_object_mut().unwrap().insert(
                "permission".to_string(),
                serde_json::json!({ "bash": "ask" }),
            );
            Ok(true)
        })
        .unwrap();

        let loaded = OpencodeConfigStore::load(dir.path()).unwrap();
        assert_eq!(loaded["permission"]["bash"], "ask");
    }

    #[test]
    fn load_recovers_trailing_garbage() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("opencode.json"),
            "{\"mcp\":{}}\n\"trailing\": true",
        )
        .unwrap();
        let loaded = OpencodeConfigStore::load(dir.path()).unwrap();
        assert!(loaded.get("mcp").is_some());
        let on_disk = fs::read_to_string(dir.path().join("opencode.json")).unwrap();
        assert!(!on_disk.contains("trailing"));
    }
}

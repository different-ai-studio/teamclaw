use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::proto::amux;

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceStore {
    #[serde(default)]
    pub workspaces: Vec<StoredWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredWorkspace {
    pub workspace_id: String,
    #[serde(default)]
    pub supabase_workspace_id: String,
    pub path: String,
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct AddWorkspaceOutcome {
    pub workspace: StoredWorkspace,
    pub inserted: bool,
}

impl WorkspaceStore {
    pub fn default_path() -> PathBuf {
        super::DaemonConfig::config_dir().join("workspaces.toml")
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        if !path.exists() {
            return Ok(Self { workspaces: vec![] });
        }
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn add(&mut self, dir_path: &str) -> crate::error::Result<AddWorkspaceOutcome> {
        let p = Path::new(dir_path);
        if !p.is_dir() {
            return Err(crate::error::AmuxError::Config(format!(
                "path is not a directory: {}",
                dir_path
            )));
        }

        // Deduplicate by canonical path
        let canonical = p.canonicalize().map_err(|e| {
            crate::error::AmuxError::Config(format!("canonicalize {}: {}", dir_path, e))
        })?;
        let canonical_str = canonical.to_string_lossy().to_string();

        if let Some(existing) = self.workspaces.iter().find(|w| w.path == canonical_str) {
            return Ok(AddWorkspaceOutcome {
                workspace: existing.clone(),
                inserted: false,
            });
        }

        let display_name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| canonical_str.clone());

        let workspace_id = uuid::Uuid::new_v4()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>();

        let workspace = StoredWorkspace {
            workspace_id,
            supabase_workspace_id: String::new(),
            path: canonical_str,
            display_name,
        };
        self.workspaces.push(workspace.clone());
        Ok(AddWorkspaceOutcome {
            workspace,
            inserted: true,
        })
    }

    pub fn remove(&mut self, workspace_id: &str) -> bool {
        let len = self.workspaces.len();
        self.workspaces.retain(|w| w.workspace_id != workspace_id);
        self.workspaces.len() < len
    }

    pub fn find_by_id(&self, workspace_id: &str) -> Option<&StoredWorkspace> {
        // Match either the local 8-char id OR the Supabase UUID — iOS/Tauri
        // clients send the Supabase id (since that's what they read from
        // the workspaces row), while CLI-spawned flows still pass the
        // local id. Looking up both keeps the caller dumb.
        self.workspaces
            .iter()
            .find(|w| w.workspace_id == workspace_id || w.supabase_workspace_id == workspace_id)
    }

    pub fn to_proto_list(&self) -> amux::WorkspaceList {
        amux::WorkspaceList {
            workspaces: self
                .workspaces
                .iter()
                .map(|w| amux::WorkspaceInfo {
                    workspace_id: w.workspace_id.clone(),
                    path: w.path.clone(),
                    display_name: w.display_name.clone(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspaceStore;

    #[test]
    fn add_reports_when_workspace_was_inserted() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = WorkspaceStore { workspaces: vec![] };

        let first = store.add(dir.path().to_str().unwrap()).unwrap();
        let second = store.add(dir.path().to_str().unwrap()).unwrap();

        assert!(first.inserted);
        assert!(!second.inserted);
        assert_eq!(first.workspace.path, second.workspace.path);
        assert_eq!(store.workspaces.len(), 1);
    }
}

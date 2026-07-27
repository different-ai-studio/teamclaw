//! Device-scoped model catalog, keyed by worktree directory.
//!
//! # Why this exists
//!
//! The model catalog is a property of the *device* — of the one global
//! `opencode serve` process and the providers configured for a given worktree
//! (see `runtime::opencode_http::supervisor`: "One serve instance per
//! daemon"). It is emphatically not a property of a single runtime binding.
//!
//! It used to be stored as one, though. `RuntimeHandle::available_models` is
//! filled from `startup.available_models` at attach time and published in that
//! handle's retained `runtime/{id}/state`. Every other binding for the same
//! device — an idle one from yesterday, a historical row replayed out of
//! `SessionStore` by `publish_all_agent_states` — advertised an **empty**
//! catalog, because it never had an attach of its own to fill it.
//!
//! Clients read that as "this runtime offers no models". The desktop's session
//! pill treats `availableModelCount == 0` as not-ready and shows 连接中 with no
//! model name, forever, for any session that is not the most recent spawn.
//! Observed 2026-07-27: two sessions on the same device, one green with 44
//! models, one stuck connecting — the difference was solely which binding had
//! done the attach.
//!
//! So the catalog is cached here once per worktree and merged into every
//! `RuntimeInfo` that would otherwise go out empty.
//!
//! # Why it is persisted
//!
//! `publish_all_agent_states` runs at startup and after every MQTT reconnect —
//! before any runtime has attached, so an in-memory-only cache would still be
//! empty at exactly the moment it is most needed. Persisting means a cold
//! daemon publishes its last-known catalog instead of nothing.
//!
//! A stale entry is safe: this list only populates a picker. The authoritative
//! check happens on `set_model`, which goes to the live serve. Publishing a
//! slightly outdated list beats publishing none — the failure mode of "none"
//! is a session that can never be used.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::proto::amux;

/// One worktree's last-known catalog.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredModel {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub provider_name: String,
}

/// Canonical worktree path → the models that worktree last advertised.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct DeviceModelCatalog {
    #[serde(default)]
    pub by_worktree: BTreeMap<String, Vec<StoredModel>>,
}

impl DeviceModelCatalog {
    pub fn default_path() -> PathBuf {
        super::DaemonConfig::migrate_legacy_file("model-catalog.toml")
    }

    /// Read the store, treating any problem (missing, unreadable, malformed) as
    /// "no catalog yet". Same convention as [`super::ModelMru`]: a cache must
    /// never fail startup.
    pub fn load(path: &Path) -> Self {
        let Ok(content) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        match toml::from_str::<Self>(&content) {
            Ok(mut store) => {
                for models in store.by_worktree.values_mut() {
                    models.retain(|m| !m.id.trim().is_empty());
                }
                store.by_worktree.retain(|_, models| !models.is_empty());
                store
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "model catalog unreadable; starting empty");
                Self::default()
            }
        }
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

    /// Replace `worktree`'s catalog. Returns whether anything changed, so the
    /// caller can skip the disk write on the common "same catalog again" path.
    ///
    /// An empty `models` is ignored rather than stored: a failed or not-yet-
    /// completed probe must not erase a good catalog — that would reintroduce
    /// exactly the empty-list bug this store exists to prevent.
    pub fn record(&mut self, worktree: &str, models: &[amux::ModelInfo]) -> bool {
        let key = worktree.trim();
        if key.is_empty() || models.is_empty() {
            return false;
        }
        let next: Vec<StoredModel> = models
            .iter()
            .filter(|m| !m.id.trim().is_empty())
            .map(|m| StoredModel {
                id: m.id.clone(),
                display_name: m.display_name.clone(),
                provider_name: m.provider_name.clone(),
            })
            .collect();
        if next.is_empty() {
            return false;
        }
        if self.by_worktree.get(key) == Some(&next) {
            return false;
        }
        self.by_worktree.insert(key.to_string(), next);
        true
    }

    /// `worktree`'s last-known catalog as proto, empty when unknown.
    pub fn models_for(&self, worktree: &str) -> Vec<amux::ModelInfo> {
        self.by_worktree
            .get(worktree.trim())
            .map(|models| {
                models
                    .iter()
                    .map(|m| amux::ModelInfo {
                        id: m.id.clone(),
                        display_name: m.display_name.clone(),
                        provider_name: m.provider_name.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Any known catalog, preferred by exact worktree match.
    ///
    /// A historical `SessionStore` row can carry a worktree this device has
    /// since stopped using (renamed directory, deleted worktree). Falling back
    /// to *some* catalog from this device is still far more useful than an
    /// empty list, because every worktree on one device is served by the same
    /// `opencode serve` with the same provider credentials — the per-worktree
    /// split exists for workspace-local `opencode.json` overrides, not for
    /// wholly disjoint model sets.
    pub fn models_for_or_any(&self, worktree: &str) -> Vec<amux::ModelInfo> {
        let exact = self.models_for(worktree);
        if !exact.is_empty() {
            return exact;
        }
        self.by_worktree
            .values()
            .next()
            .map(|models| {
                models
                    .iter()
                    .map(|m| amux::ModelInfo {
                        id: m.id.clone(),
                        display_name: m.display_name.clone(),
                        provider_name: m.provider_name.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> amux::ModelInfo {
        amux::ModelInfo {
            id: id.to_string(),
            display_name: id.to_string(),
            provider_name: "test".to_string(),
        }
    }

    #[test]
    fn record_stores_and_dedupes() {
        let mut cat = DeviceModelCatalog::default();
        assert!(cat.record("/w1", &[model("a/x"), model("a/y")]));
        // Same catalog again is a no-op, so callers can skip the disk write.
        assert!(!cat.record("/w1", &[model("a/x"), model("a/y")]));
        assert!(cat.record("/w1", &[model("a/x")]));
        assert_eq!(cat.models_for("/w1").len(), 1);
    }

    #[test]
    fn record_ignores_empty_so_a_failed_probe_cannot_erase_a_good_catalog() {
        let mut cat = DeviceModelCatalog::default();
        cat.record("/w1", &[model("a/x")]);
        assert!(!cat.record("/w1", &[]));
        assert_eq!(cat.models_for("/w1").len(), 1);
    }

    #[test]
    fn models_for_or_any_falls_back_to_another_worktree() {
        let mut cat = DeviceModelCatalog::default();
        cat.record("/w1", &[model("a/x")]);
        // Unknown worktree — a historical session row from a directory that no
        // longer exists still gets this device's catalog.
        assert_eq!(cat.models_for("/gone").len(), 0);
        assert_eq!(cat.models_for_or_any("/gone").len(), 1);
    }

    #[test]
    fn load_missing_file_is_empty_not_an_error() {
        let path = std::env::temp_dir().join("amuxd-test-catalog-missing.toml");
        let _ = std::fs::remove_file(&path);
        assert!(DeviceModelCatalog::load(&path).by_worktree.is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let path = std::env::temp_dir()
            .join("amuxd-test-model-catalog")
            .join(format!("{}.toml", uuid::Uuid::new_v4()));
        let mut cat = DeviceModelCatalog::default();
        cat.record("/w1", &[model("a/x"), model("a/y")]);
        cat.save(&path).expect("save");
        let loaded = DeviceModelCatalog::load(&path);
        assert_eq!(loaded.models_for("/w1").len(), 2);
        assert_eq!(loaded.models_for("/w1")[0].id, "a/x");
        let _ = std::fs::remove_file(&path);
    }
}

//! Daemon-side most-recently-used model list, shared by every surface that
//! starts a runtime: the desktop, the gateway channels (WeCom / Feishu / …)
//! and cron.
//!
//! Why this lives in the daemon rather than a client: the desktop already
//! remembered a last pick in `agent-model-pick-store.ts`, but that is
//! `localStorage` — gateway and cron runtimes are started inside amuxd and can
//! never see it, so they had no notion of "the model this device actually
//! uses". One store here gives all three the same answer.
//!
//! The shape mirrors what opencode keeps in `~/.local/state/opencode/model.json`
//! (`recent`, newest first, capped): a single last-used value is not enough,
//! because the thing it names can stop working — a provider gets logged out, a
//! key expires, a model is retired. A list plus [`first_available`] degrades to
//! the next usable entry instead of pinning something that cannot run.
//!
//! Deliberately *not* shared with opencode's own file: that format is
//! undocumented and would couple us to their internals. See
//! [`first_available`] for the resolution rule this store participates in.
//!
//! # Why the list is keyed by backend
//!
//! Model ids are backend-local: `opencode/big-pickle` means nothing to pi, and
//! a pi id means nothing to opencode. One flat list mixed both namespaces, and
//! while [`first_available`] would skip the foreign entries, they still take up
//! slots — switch backends a few times and the list is mostly noise.
//!
//! Keying by *agent actor* — the way the desktop's old `lastByAgent` did —
//! does not translate here: a daemon has exactly one agent actor
//! (`Backend::actor_id`), so that key would be a constant. The desktop needed
//! it because it talks to several agents; amuxd is one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How many entries to keep. Matches opencode's own list length; long enough to
/// survive a couple of dead providers, short enough to stay comprehensible.
const MAX_RECENT: usize = 10;

/// Backend id (`"opencode"` / `"pi"`) → its `provider/model` ids, most recently
/// used first.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ModelMru {
    #[serde(default)]
    pub by_backend: BTreeMap<String, Vec<String>>,
}

impl ModelMru {
    /// Test builds resolve the path per-manager instead (see
    /// `RuntimeManager::with_local_agent`), so this has no caller there.
    #[allow(dead_code)]
    pub fn default_path() -> PathBuf {
        super::DaemonConfig::migrate_legacy_file("model-mru.toml")
    }

    /// Read the store, treating any problem (missing, unreadable, malformed) as
    /// "no history yet". This is a convenience cache, never a source of truth —
    /// failing startup over it would be worse than forgetting a preference.
    pub fn load(path: &Path) -> Self {
        let Ok(content) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        match toml::from_str::<Self>(&content) {
            Ok(mut store) => {
                for recent in store.by_backend.values_mut() {
                    recent.retain(|id| !id.trim().is_empty());
                    recent.truncate(MAX_RECENT);
                }
                store.by_backend.retain(|_, recent| !recent.is_empty());
                store
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "model MRU unreadable; starting empty");
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

    /// Move `model_id` to the front of `backend`'s list. Returns whether the
    /// list changed, so callers can skip the disk write on the common "same
    /// model again" path.
    pub fn record(&mut self, backend: &str, model_id: &str) -> bool {
        let id = model_id.trim();
        let backend = backend.trim();
        if id.is_empty() || backend.is_empty() {
            return false;
        }
        let recent = self.by_backend.entry(backend.to_string()).or_default();
        if recent.first().map(String::as_str) == Some(id) {
            return false;
        }
        recent.retain(|existing| existing != id);
        recent.insert(0, id.to_string());
        recent.truncate(MAX_RECENT);
        true
    }

    /// `backend`'s recent models, newest first. Empty for a backend this device
    /// has not run yet — which is the point of the split: starting pi for the
    /// first time must not inherit opencode's history.
    pub fn recent_for(&self, backend: &str) -> &[String] {
        self.by_backend
            .get(backend.trim())
            .map(Vec::as_slice)
            .unwrap_or_default()
    }
}

/// Pick the first candidate that the live catalog still offers.
///
/// This is the rule opencode applies to its own resolution: every level —
/// explicit pick, session history, config default, MRU — is checked against
/// what the provider list currently advertises, so a stale entry falls through
/// rather than being handed to the runtime and failing on the first turn.
///
/// `available` empty means the catalog fetch failed, not that nothing is
/// runnable. In that case the check is skipped and the first candidate wins:
/// a transient fetch failure must not silently discard the user's choice.
pub fn first_available<I>(candidates: I, available: &[String]) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let mut candidates = candidates.into_iter().filter(|id| !id.trim().is_empty());
    if available.is_empty() {
        return candidates.next();
    }
    candidates.find(|id| available.iter().any(|a| a == id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn mru_with(backend: &str, models: &[&str]) -> ModelMru {
        let mut mru = ModelMru::default();
        mru.by_backend.insert(backend.to_string(), ids(models));
        mru
    }

    #[test]
    fn record_moves_an_existing_entry_to_the_front() {
        let mut mru = mru_with("opencode", &["a/1", "b/2", "c/3"]);
        assert!(mru.record("opencode", "c/3"));
        assert_eq!(mru.recent_for("opencode"), ids(&["c/3", "a/1", "b/2"]));
    }

    #[test]
    fn record_is_a_noop_when_already_current() {
        let mut mru = mru_with("opencode", &["a/1", "b/2"]);
        assert!(!mru.record("opencode", "a/1"));
        assert!(!mru.record("opencode", "  "));
        assert!(!mru.record("  ", "a/1"));
        assert_eq!(mru.recent_for("opencode"), ids(&["a/1", "b/2"]));
    }

    #[test]
    fn record_caps_each_backend_list() {
        let mut mru = ModelMru::default();
        for i in 0..(MAX_RECENT + 5) {
            assert!(mru.record("opencode", &format!("p/{i}")));
        }
        assert_eq!(mru.recent_for("opencode").len(), MAX_RECENT);
        assert_eq!(
            mru.recent_for("opencode")[0],
            format!("p/{}", MAX_RECENT + 4)
        );
    }

    #[test]
    fn backends_do_not_share_history() {
        // Model ids are backend-local, so pi must not inherit opencode's —
        // they would never match pi's catalog anyway, just crowd the list.
        let mut mru = ModelMru::default();
        mru.record("opencode", "opencode/big-pickle");
        mru.record("pi", "anthropic/claude-sonnet-4-6");

        assert_eq!(mru.recent_for("opencode"), ids(&["opencode/big-pickle"]));
        assert_eq!(mru.recent_for("pi"), ids(&["anthropic/claude-sonnet-4-6"]));
        assert!(mru.recent_for("never-run").is_empty());
    }

    #[test]
    fn first_available_skips_entries_the_catalog_dropped() {
        // The point of the whole store: "last used" was `gone/x`, but that
        // provider is no longer offered, so the next usable entry wins.
        let candidates = ids(&["gone/x", "live/y", "live/z"]);
        let available = ids(&["live/y", "live/z", "other/w"]);
        assert_eq!(
            first_available(candidates, &available).as_deref(),
            Some("live/y")
        );
    }

    #[test]
    fn first_available_returns_none_when_nothing_matches() {
        let candidates = ids(&["gone/x"]);
        let available = ids(&["live/y"]);
        assert_eq!(first_available(candidates, &available), None);
    }

    #[test]
    fn first_available_skips_the_check_when_the_catalog_is_empty() {
        // Catalog fetch failed — don't punish the user by dropping their pick.
        let candidates = ids(&["", "picked/model"]);
        assert_eq!(
            first_available(candidates, &[]).as_deref(),
            Some("picked/model")
        );
    }

    #[test]
    fn load_of_a_missing_or_corrupt_file_is_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("model-mru.toml");
        assert!(ModelMru::load(&missing).by_backend.is_empty());

        let corrupt = dir.path().join("corrupt.toml");
        std::fs::write(&corrupt, "this is not toml {{{").unwrap();
        assert!(ModelMru::load(&corrupt).by_backend.is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("model-mru.toml");
        let mut mru = ModelMru::default();
        mru.record("opencode", "anthropic/claude-sonnet-4-6");
        mru.record("opencode", "opencode/big-pickle");
        mru.record("pi", "pi-provider/some-model");
        mru.save(&path).unwrap();

        let loaded = ModelMru::load(&path);
        assert_eq!(
            loaded.recent_for("opencode"),
            ids(&["opencode/big-pickle", "anthropic/claude-sonnet-4-6"])
        );
        assert_eq!(loaded.recent_for("pi"), ids(&["pi-provider/some-model"]));
    }
}

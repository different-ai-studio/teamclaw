//! Candidate → runnable model resolution.
//!
//! Extracted from `config::model_mru` when ADR-0007 deleted that store. The
//! rule outlived the MRU because it was never about history: every level that
//! proposes a model — an explicit pick, a session's stored value, a config
//! default — can propose one the backend no longer serves, and handing that to
//! the runtime fails on the first turn.

/// Pick the first candidate the live catalog still offers.
///
/// `available` empty means the catalog fetch failed, not that nothing is
/// runnable. In that case the check is skipped and the first candidate wins: a
/// transient fetch failure must not silently discard the caller's choice.
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

    #[test]
    fn skips_entries_the_catalog_dropped() {
        // The point: the caller's first choice names a provider that is no
        // longer offered, so the next usable candidate wins.
        assert_eq!(
            first_available(ids(&["gone/x", "live/y"]), &ids(&["live/y", "other/w"])).as_deref(),
            Some("live/y")
        );
    }

    #[test]
    fn returns_none_when_nothing_matches() {
        assert_eq!(first_available(ids(&["gone/x"]), &ids(&["live/y"])), None);
    }

    #[test]
    fn skips_the_check_when_the_catalog_is_empty() {
        // Catalog fetch failed — don't punish the caller by dropping its pick.
        assert_eq!(
            first_available(ids(&["", "picked/model"]), &[]).as_deref(),
            Some("picked/model")
        );
    }
}

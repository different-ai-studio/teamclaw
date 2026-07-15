use std::collections::HashMap;
use std::time::{Duration, Instant};

const TARGET_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone)]
struct SessionTarget {
    member_actor_id: String,
    updated_at: Instant,
}

/// Fallback map `session_id → member_actor_id` when no live runtime handle
/// carries `remote_tool_member_id` (e.g. between resume and next engage).
#[derive(Default)]
pub struct SessionRemoteTargetStore {
    by_session: HashMap<String, SessionTarget>,
}

impl SessionRemoteTargetStore {
    pub fn set(&mut self, session_id: &str, member_actor_id: &str) {
        if session_id.is_empty() || member_actor_id.is_empty() {
            return;
        }
        self.by_session.insert(
            session_id.to_string(),
            SessionTarget {
                member_actor_id: member_actor_id.to_string(),
                updated_at: Instant::now(),
            },
        );
    }

    pub fn get(&self, session_id: &str) -> Option<&str> {
        self.by_session.get(session_id).and_then(|t| {
            if t.updated_at.elapsed() > TARGET_TTL {
                None
            } else {
                Some(t.member_actor_id.as_str())
            }
        })
    }

    pub fn prune_expired(&mut self) {
        self.by_session
            .retain(|_, t| t.updated_at.elapsed() <= TARGET_TTL);
    }
}

/// Prefer the live runtime binding; fall back to the session store.
pub fn resolve_member_for_session(
    agents: &crate::runtime::RuntimeManager,
    store: &SessionRemoteTargetStore,
    session_id: &str,
) -> Option<String> {
    agents
        .remote_tool_member_for_session(session_id)
        .or_else(|| store.get(session_id).map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_and_get_member_actor() {
        let mut store = SessionRemoteTargetStore::default();
        store.set("s1", "member-a");
        assert_eq!(store.get("s1"), Some("member-a"));
    }

    #[test]
    fn latest_explicit_bind_wins_in_store() {
        let mut store = SessionRemoteTargetStore::default();
        store.set("s1", "member-a");
        store.set("s1", "member-b");
        assert_eq!(store.get("s1"), Some("member-b"));
    }
}

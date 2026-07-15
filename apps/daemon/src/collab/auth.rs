use std::time::SystemTime;

use chrono::{Duration, Utc};
use tracing::{info, warn};
use uuid::Uuid;

use crate::config::{MemberStore, PendingInvite, StoredMember};
use crate::proto::amux;

pub struct AuthManager {
    store_path: std::path::PathBuf,
    store: MemberStore,
    /// Mtime of `members.toml` last time we loaded it. Used by `reload_if_changed`
    /// to pick up out-of-process edits (e.g. `amuxd invite` writing a new pending
    /// invite while the daemon is running) without needing a file watcher.
    last_loaded: Option<SystemTime>,
}

pub enum AuthResult {
    Accepted { member: StoredMember },
    Rejected { reason: String },
}

impl AuthManager {
    pub fn new(store_path: std::path::PathBuf) -> crate::error::Result<Self> {
        let store = MemberStore::load(&store_path)?;
        let last_loaded = Self::read_mtime(&store_path);
        Ok(Self {
            store_path,
            store,
            last_loaded,
        })
    }

    fn read_mtime(path: &std::path::Path) -> Option<SystemTime> {
        std::fs::metadata(path).and_then(|m| m.modified()).ok()
    }

    /// Reloads `members.toml` from disk if its mtime is newer than our last load.
    /// Called at the start of every read path so CLI-created invites are visible
    /// to a running daemon without requiring a restart.
    fn reload_if_changed(&mut self) {
        let Some(mtime) = Self::read_mtime(&self.store_path) else {
            return;
        };
        if self.last_loaded.map_or(true, |lt| mtime > lt) {
            match MemberStore::load(&self.store_path) {
                Ok(store) => {
                    self.store = store;
                    self.last_loaded = Some(mtime);
                    info!("members.toml reloaded from disk");
                }
                Err(e) => warn!("members.toml reload failed: {}", e),
            }
        }
    }

    fn save_and_mark(&mut self) {
        if let Err(e) = self.store.save(&self.store_path) {
            warn!("members.toml save failed: {}", e);
            return;
        }
        self.last_loaded = Self::read_mtime(&self.store_path);
    }

    pub fn authenticate(&mut self, token: &str) -> AuthResult {
        self.reload_if_changed();

        if let Some(member) = self.store.find_member_by_token(token) {
            return AuthResult::Accepted {
                member: member.clone(),
            };
        }

        if self.store.find_pending_invite(token).is_some() {
            let invite = self.store.consume_invite(token).unwrap();
            let member = StoredMember {
                member_id: Uuid::new_v4().to_string(),
                display_name: invite.display_name.clone(),
                role: invite.role.clone(),
                token: invite.invite_token.clone(), // Keep invite token so iOS can re-auth
                joined_at: Utc::now(),
                department: None,
            };
            self.store.add_member(member.clone());
            self.save_and_mark();
            return AuthResult::Accepted { member };
        }

        AuthResult::Rejected {
            reason: "invalid or expired token".into(),
        }
    }

    #[allow(dead_code)]
    pub fn create_invite(
        &mut self,
        display_name: &str,
        expires_hours: u32,
        role: &str,
    ) -> crate::error::Result<PendingInvite> {
        self.reload_if_changed();
        let invite = PendingInvite {
            invite_token: Uuid::new_v4().to_string(),
            display_name: display_name.into(),
            created_at: Utc::now(),
            expires_at: Utc::now() + Duration::hours(expires_hours as i64),
            role: role.into(),
        };
        self.store.add_invite(invite.clone());
        self.store.save(&self.store_path)?;
        self.last_loaded = Self::read_mtime(&self.store_path);
        Ok(invite)
    }

    pub fn remove_member(&mut self, member_id: &str) -> crate::error::Result<bool> {
        self.reload_if_changed();
        let removed = self.store.remove_member(member_id);
        if removed {
            self.store.save(&self.store_path)?;
            self.last_loaded = Self::read_mtime(&self.store_path);
        }
        Ok(removed)
    }

    #[allow(dead_code)]
    pub fn to_proto_member_list(&mut self) -> amux::MemberList {
        self.reload_if_changed();
        amux::MemberList {
            members: self
                .store
                .members
                .iter()
                .map(|m| amux::MemberInfo {
                    member_id: m.member_id.clone(),
                    display_name: m.display_name.clone(),
                    role: if m.is_owner() {
                        amux::MemberRole::Owner as i32
                    } else {
                        amux::MemberRole::Member as i32
                    },
                    joined_at: m.joined_at.timestamp(),
                    department: m.department.clone().unwrap_or_default(),
                })
                .collect(),
        }
    }

    pub fn is_owner(&mut self, member_id: &str) -> bool {
        self.reload_if_changed();
        self.store
            .members
            .iter()
            .any(|m| m.member_id == member_id && m.is_owner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MemberStore, StoredMember};
    use chrono::TimeZone;
    use tempfile::tempdir;

    fn make_auth_with(members: Vec<StoredMember>) -> AuthManager {
        let dir = tempdir().unwrap();
        let path = dir.path().join("members.toml");
        let store = MemberStore {
            members,
            pending_invites: vec![],
        };
        store.save(&path).unwrap();
        // Keep the tempdir alive by leaking it for the test's duration.
        Box::leak(Box::new(dir));
        AuthManager::new(path).unwrap()
    }

    fn member(id: &str, department: Option<&str>) -> StoredMember {
        StoredMember {
            member_id: id.to_string(),
            display_name: format!("Member {}", id),
            role: "member".into(),
            token: format!("tok-{}", id),
            joined_at: Utc.with_ymd_and_hms(2026, 4, 17, 12, 0, 0).unwrap(),
            department: department.map(|s| s.to_string()),
        }
    }

    #[test]
    fn proto_member_list_includes_department_when_set() {
        let mut auth = make_auth_with(vec![
            member("alice", Some("Engineering")),
            member("bob", None),
        ]);
        let list = auth.to_proto_member_list();
        assert_eq!(list.members.len(), 2);
        assert_eq!(list.members[0].department, "Engineering");
        // Bob has no department — proto3 emits empty string.
        assert_eq!(list.members[1].department, "");
    }
}

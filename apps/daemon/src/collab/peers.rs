use crate::proto::amux;
use std::collections::HashMap;

pub struct PeerState {
    pub peer_id: String,
    pub member_id: String,
    pub display_name: String,
    pub device_type: String,
    pub role: amux::MemberRole,
    pub connected_at: i64,
}

pub struct PeerTracker {
    peers: HashMap<String, PeerState>,
}

impl PeerTracker {
    pub fn new() -> Self {
        Self {
            peers: HashMap::new(),
        }
    }

    pub fn add_peer(&mut self, state: PeerState) {
        self.peers.insert(state.peer_id.clone(), state);
    }

    pub fn remove_peer(&mut self, peer_id: &str) -> Option<PeerState> {
        self.peers.remove(peer_id)
    }

    pub fn remove_by_member_id(&mut self, member_id: &str) -> Vec<PeerState> {
        let ids: Vec<String> = self
            .peers
            .iter()
            .filter(|(_, p)| p.member_id == member_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| self.peers.remove(&id))
            .collect()
    }

    pub fn get_peer(&self, peer_id: &str) -> Option<&PeerState> {
        self.peers.get(peer_id)
    }

    pub fn to_proto_peer_list(&self) -> amux::PeerList {
        amux::PeerList {
            peers: self
                .peers
                .values()
                .map(|p| amux::PeerInfo {
                    peer_id: p.peer_id.clone(),
                    member_id: p.member_id.clone(),
                    display_name: p.display_name.clone(),
                    device_type: p.device_type.clone(),
                    role: p.role as i32,
                    connected_at: p.connected_at,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux;

    fn make_peer(peer_id: &str, member_id: &str) -> PeerState {
        PeerState {
            peer_id: peer_id.to_string(),
            member_id: member_id.to_string(),
            display_name: "Alice".to_string(),
            device_type: "desktop".to_string(),
            role: amux::MemberRole::Member,
            connected_at: 0,
        }
    }

    #[test]
    fn add_and_get_peer() {
        let mut tracker = PeerTracker::new();
        tracker.add_peer(make_peer("p1", "m1"));
        assert!(tracker.get_peer("p1").is_some());
        assert_eq!(tracker.get_peer("p1").unwrap().member_id, "m1");
    }

    #[test]
    fn remove_peer_returns_state() {
        let mut tracker = PeerTracker::new();
        tracker.add_peer(make_peer("p1", "m1"));
        let removed = tracker.remove_peer("p1");
        assert!(removed.is_some());
        assert_eq!(removed.unwrap().peer_id, "p1");
        assert!(tracker.get_peer("p1").is_none());
    }

    #[test]
    fn remove_missing_peer_returns_none() {
        let mut tracker = PeerTracker::new();
        assert!(tracker.remove_peer("nope").is_none());
    }

    #[test]
    fn remove_by_member_id_removes_all_matching() {
        let mut tracker = PeerTracker::new();
        tracker.add_peer(make_peer("p1", "m1"));
        tracker.add_peer(make_peer("p2", "m1"));
        tracker.add_peer(make_peer("p3", "m2"));
        let removed = tracker.remove_by_member_id("m1");
        assert_eq!(removed.len(), 2);
        assert!(tracker.get_peer("p1").is_none());
        assert!(tracker.get_peer("p2").is_none());
        assert!(tracker.get_peer("p3").is_some());
    }

    #[test]
    fn remove_by_member_id_no_match_returns_empty() {
        let mut tracker = PeerTracker::new();
        tracker.add_peer(make_peer("p1", "m1"));
        assert!(tracker.remove_by_member_id("m99").is_empty());
    }

    #[test]
    fn add_peer_overwrites_same_peer_id() {
        let mut tracker = PeerTracker::new();
        tracker.add_peer(make_peer("p1", "m1"));
        let mut replacement = make_peer("p1", "m2");
        replacement.display_name = "Bob".to_string();
        tracker.add_peer(replacement);
        assert_eq!(tracker.get_peer("p1").unwrap().member_id, "m2");
    }

    #[test]
    fn to_proto_peer_list_includes_all_peers() {
        let mut tracker = PeerTracker::new();
        tracker.add_peer(make_peer("p1", "m1"));
        tracker.add_peer(make_peer("p2", "m2"));
        let list = tracker.to_proto_peer_list();
        assert_eq!(list.peers.len(), 2);
        let ids: Vec<_> = list.peers.iter().map(|p| p.peer_id.as_str()).collect();
        assert!(ids.contains(&"p1"));
        assert!(ids.contains(&"p2"));
    }

    #[test]
    fn to_proto_peer_list_empty_tracker() {
        let tracker = PeerTracker::new();
        assert!(tracker.to_proto_peer_list().peers.is_empty());
    }
}

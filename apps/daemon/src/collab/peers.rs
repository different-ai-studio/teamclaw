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

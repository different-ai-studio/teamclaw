pub fn session_live(team_id: &str, session_id: &str) -> String {
    teamclaw_types::mqtt::session_live(team_id, session_id)
}

pub fn actor_rpc_req(team_id: &str, actor_id: &str) -> String {
    format!("amux/{team_id}/{actor_id}/rpc-req")
}

pub fn actor_rpc_res(team_id: &str, actor_id: &str) -> String {
    format!("amux/{team_id}/{actor_id}/rpc-res")
}

pub fn runtime_events(team_id: &str, actor_id: &str, runtime_id: &str) -> String {
    teamclaw_types::mqtt::runtime_events(team_id, actor_id, runtime_id)
}

pub fn actor_state(team_id: &str, actor_id: &str) -> String {
    teamclaw_types::mqtt::actor_state(team_id, actor_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_live_format() {
        assert_eq!(session_live("t1", "s1"), "amux/t1/session/s1/live");
    }
    #[test]
    fn actor_rpc_pair() {
        assert_eq!(actor_rpc_req("t1", "d1"), "amux/t1/d1/rpc-req");
        assert_eq!(actor_rpc_res("t1", "d1"), "amux/t1/d1/rpc-res");
    }
    #[test]
    fn runtime_events_format() {
        assert_eq!(
            runtime_events("t1", "d1", "r1"),
            "amux/t1/d1/runtime/r1/events"
        );
    }
    #[test]
    fn actor_state_format() {
        assert_eq!(actor_state("t1", "d1"), "amux/t1/d1/state");
    }
}

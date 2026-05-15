pub fn session_live(team_id: &str, session_id: &str) -> String {
    teamclaw_types::mqtt::session_live(team_id, session_id)
}

pub fn device_rpc_req(team_id: &str, daemon_id: &str) -> String {
    format!("amux/{team_id}/device/{daemon_id}/rpc-req")
}

pub fn device_rpc_res(team_id: &str, daemon_id: &str) -> String {
    format!("amux/{team_id}/device/{daemon_id}/rpc-res")
}

pub fn runtime_events(team_id: &str, daemon_id: &str, runtime_id: &str) -> String {
    teamclaw_types::mqtt::runtime_events(team_id, daemon_id, runtime_id)
}

pub fn device_state(team_id: &str, daemon_id: &str) -> String {
    teamclaw_types::mqtt::device_state(team_id, daemon_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_live_format() {
        assert_eq!(session_live("t1", "s1"), "amux/t1/session/s1/live");
    }
    #[test]
    fn device_rpc_pair() {
        assert_eq!(device_rpc_req("t1", "d1"), "amux/t1/device/d1/rpc-req");
        assert_eq!(device_rpc_res("t1", "d1"), "amux/t1/device/d1/rpc-res");
    }
    #[test]
    fn runtime_events_format() {
        assert_eq!(
            runtime_events("t1", "d1", "r1"),
            "amux/t1/device/d1/runtime/r1/events"
        );
    }
    #[test]
    fn device_state_format() {
        assert_eq!(device_state("t1", "d1"), "amux/t1/device/d1/state");
    }
}

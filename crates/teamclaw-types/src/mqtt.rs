/// Builds MQTT topic paths for a given team-scoped device namespace.
pub struct Topics {
    team_id: String,
    device_id: String,
}

impl Topics {
    pub fn new(team_id: &str, device_id: &str) -> Self {
        Self {
            team_id: team_id.to_string(),
            device_id: device_id.to_string(),
        }
    }

    fn device_base(&self) -> String {
        format!("amux/{}/device/{}", self.team_id, self.device_id)
    }

    /// RPC response topic for an arbitrary device.
    pub fn rpc_res_for(&self, device_id: &str) -> String {
        format!("amux/{}/device/{}/rpc/res", self.team_id, device_id)
    }

    pub fn device_rpc_req(&self) -> String {
        format!("{}/rpc/req", self.device_base())
    }

    pub fn device_rpc_res(&self) -> String {
        format!("{}/rpc/res", self.device_base())
    }

    pub fn device_notify(&self) -> String {
        format!("{}/notify", self.device_base())
    }

    pub fn session_live(&self, session_id: &str) -> String {
        session_live(&self.team_id, session_id)
    }

    pub fn device_state(&self) -> String {
        device_state(&self.team_id, &self.device_id)
    }

    pub fn runtime_state(&self, runtime_id: &str) -> String {
        format!("{}/runtime/{}/state", self.device_base(), runtime_id)
    }

    pub fn runtime_events(&self, runtime_id: &str) -> String {
        runtime_events(&self.team_id, &self.device_id, runtime_id)
    }

    pub fn runtime_commands(&self, runtime_id: &str) -> String {
        format!("{}/runtime/{}/commands", self.device_base(), runtime_id)
    }

    pub fn runtime_state_wildcard(&self) -> String {
        format!("{}/runtime/+/state", self.device_base())
    }

    pub fn runtime_commands_wildcard(&self) -> String {
        format!("{}/runtime/+/commands", self.device_base())
    }

    pub fn user_notify(&self, actor_id: &str) -> String {
        format!("amux/{}/user/{}/notify", self.team_id, actor_id)
    }
}

pub fn session_live(team_id: &str, session_id: &str) -> String {
    format!("amux/{team_id}/session/{session_id}/live")
}

pub fn device_state(team_id: &str, device_id: &str) -> String {
    format!("amux/{team_id}/device/{device_id}/state")
}

pub fn runtime_events(team_id: &str, device_id: &str, runtime_id: &str) -> String {
    format!("amux/{team_id}/device/{device_id}/runtime/{runtime_id}/events")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_topic_functions_match_wire_paths() {
        assert_eq!(session_live("t1", "s1"), "amux/t1/session/s1/live");
        assert_eq!(device_state("t1", "d1"), "amux/t1/device/d1/state");
        assert_eq!(
            runtime_events("t1", "d1", "r1"),
            "amux/t1/device/d1/runtime/r1/events"
        );
    }

    #[test]
    fn device_topic_builder_matches_daemon_paths() {
        let t = Topics::new("team1", "dev-a");
        assert_eq!(t.device_rpc_req(), "amux/team1/device/dev-a/rpc/req");
        assert_eq!(t.device_rpc_res(), "amux/team1/device/dev-a/rpc/res");
        assert_eq!(t.device_notify(), "amux/team1/device/dev-a/notify");
        assert_eq!(t.session_live("s1"), "amux/team1/session/s1/live");
        assert_eq!(t.device_state(), "amux/team1/device/dev-a/state");
        assert_eq!(
            t.runtime_state("r1"),
            "amux/team1/device/dev-a/runtime/r1/state"
        );
        assert_eq!(
            t.runtime_events("r1"),
            "amux/team1/device/dev-a/runtime/r1/events"
        );
        assert_eq!(
            t.runtime_commands("r1"),
            "amux/team1/device/dev-a/runtime/r1/commands"
        );
        assert_eq!(
            t.runtime_state_wildcard(),
            "amux/team1/device/dev-a/runtime/+/state"
        );
        assert_eq!(
            t.runtime_commands_wildcard(),
            "amux/team1/device/dev-a/runtime/+/commands"
        );
        assert_eq!(
            t.user_notify("actor-xyz"),
            "amux/team1/user/actor-xyz/notify"
        );
    }
}

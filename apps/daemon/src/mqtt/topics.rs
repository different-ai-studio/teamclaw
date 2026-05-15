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

    /// RPC response topic for an arbitrary device (used when replying to a
    /// request whose sender_device_id differs from our own device_id).
    pub fn rpc_res_for(&self, device_id: &str) -> String {
        format!("amux/{}/device/{}/rpc/res", self.team_id, device_id)
    }

    // ─── Teamclaw (absorbed from teamclaw/topics.rs in Phase 1a) ───

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
        format!("amux/{}/session/{}/live", self.team_id, session_id)
    }

    // ─── Phase 1 dual-write additions ───

    /// New device-scoped retained state topic. LWT migrates here in Phase 3.
    pub fn device_state(&self) -> String {
        format!("{}/state", self.device_base())
    }

    /// Per-runtime retained state. iOS subscribes via runtime_state_wildcard.
    pub fn runtime_state(&self, runtime_id: &str) -> String {
        format!("{}/runtime/{}/state", self.device_base(), runtime_id)
    }

    /// Per-runtime event stream.
    pub fn runtime_events(&self, runtime_id: &str) -> String {
        format!("{}/runtime/{}/events", self.device_base(), runtime_id)
    }

    /// Per-runtime command stream.
    pub fn runtime_commands(&self, runtime_id: &str) -> String {
        format!("{}/runtime/{}/commands", self.device_base(), runtime_id)
    }

    /// Wildcard for aggregating all retained runtime states for this device.
    pub fn runtime_state_wildcard(&self) -> String {
        format!("{}/runtime/+/state", self.device_base())
    }

    /// Wildcard for subscribing to all incoming runtime commands for this device.
    pub fn runtime_commands_wildcard(&self) -> String {
        format!("{}/runtime/+/commands", self.device_base())
    }

    /// Team-scoped user notify channel. Requires broker JWT auth before use
    /// (Phase 1c prerequisite); path builder available now for Phase 2 iOS.
    pub fn user_notify(&self, actor_id: &str) -> String {
        format!("amux/{}/user/{}/notify", self.team_id, actor_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absorbed_rpc_paths() {
        let t = Topics::new("team1", "dev-a");
        assert_eq!(t.device_rpc_req(), "amux/team1/device/dev-a/rpc/req");
        assert_eq!(t.device_rpc_res(), "amux/team1/device/dev-a/rpc/res");
    }

    #[test]
    fn absorbed_notify_and_session_live() {
        let t = Topics::new("team1", "dev-a");
        assert_eq!(t.device_notify(), "amux/team1/device/dev-a/notify");
        assert_eq!(t.session_live("s1"), "amux/team1/session/s1/live");
    }

    #[test]
    fn new_device_state_and_runtime_paths() {
        let t = Topics::new("team1", "dev-a");
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
    }

    #[test]
    fn user_notify_path() {
        let t = Topics::new("team1", "dev-a");
        assert_eq!(
            t.user_notify("actor-xyz"),
            "amux/team1/user/actor-xyz/notify"
        );
    }
}

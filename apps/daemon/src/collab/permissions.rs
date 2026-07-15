use crate::proto::amux;
use std::collections::HashSet;

pub struct PermissionManager {
    pending: HashSet<String>,
    resolved: HashSet<String>,
}

impl PermissionManager {
    pub fn new() -> Self {
        Self {
            pending: HashSet::new(),
            resolved: HashSet::new(),
        }
    }

    pub fn check_command_permission(
        &self,
        role: amux::MemberRole,
        command: &amux::acp_command::Command,
    ) -> Result<(), String> {
        match command {
            amux::acp_command::Command::StartAgent(_)
            | amux::acp_command::Command::StopAgent(_) => {
                if role != amux::MemberRole::Owner {
                    return Err("permission denied: owner only".into());
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn check_agent_busy(&self, status: amux::AgentStatus) -> Result<(), String> {
        if status == amux::AgentStatus::Active {
            return Err("agent is busy".into());
        }
        Ok(())
    }

    pub fn register_pending(&mut self, request_id: &str) {
        self.pending.insert(request_id.to_string());
    }

    pub fn try_resolve_permission(&mut self, request_id: &str) -> bool {
        self.pending.remove(request_id);
        self.resolved.insert(request_id.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::amux;

    fn start_agent_cmd() -> amux::acp_command::Command {
        amux::acp_command::Command::StartAgent(amux::AcpStartAgent {
            workspace_id: "ws".into(),
            ..Default::default()
        })
    }

    fn stop_agent_cmd() -> amux::acp_command::Command {
        amux::acp_command::Command::StopAgent(amux::AcpStopAgent {})
    }

    fn send_prompt_cmd() -> amux::acp_command::Command {
        amux::acp_command::Command::SendPrompt(amux::AcpSendPrompt {
            text: "hi".into(),
            ..Default::default()
        })
    }

    #[test]
    fn owner_can_start_agent() {
        let pm = PermissionManager::new();
        assert!(pm
            .check_command_permission(amux::MemberRole::Owner, &start_agent_cmd())
            .is_ok());
    }

    #[test]
    fn member_cannot_start_agent() {
        let pm = PermissionManager::new();
        assert!(pm
            .check_command_permission(amux::MemberRole::Member, &start_agent_cmd())
            .is_err());
    }

    #[test]
    fn member_cannot_stop_agent() {
        let pm = PermissionManager::new();
        assert!(pm
            .check_command_permission(amux::MemberRole::Member, &stop_agent_cmd())
            .is_err());
    }

    #[test]
    fn member_can_send_prompt() {
        let pm = PermissionManager::new();
        assert!(pm
            .check_command_permission(amux::MemberRole::Member, &send_prompt_cmd())
            .is_ok());
    }

    #[test]
    fn active_agent_is_busy() {
        let pm = PermissionManager::new();
        assert!(pm.check_agent_busy(amux::AgentStatus::Active).is_err());
    }

    #[test]
    fn idle_agent_not_busy() {
        let pm = PermissionManager::new();
        assert!(pm.check_agent_busy(amux::AgentStatus::Idle).is_ok());
    }

    #[test]
    fn pending_and_resolve_flow() {
        let mut pm = PermissionManager::new();
        pm.register_pending("req-1");
        assert!(pm.try_resolve_permission("req-1"));
        // second resolve of same id is idempotent (already in resolved set)
        assert!(!pm.try_resolve_permission("req-1"));
    }

    #[test]
    fn resolve_unknown_id_returns_true_first_time() {
        let mut pm = PermissionManager::new();
        // never registered, but resolved set insert returns true the first time
        assert!(pm.try_resolve_permission("unknown"));
    }
}

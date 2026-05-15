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

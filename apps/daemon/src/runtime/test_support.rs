use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::acp_event_frame::AcpEventFrame;
use super::backend::{AcpCommand, AcpStartupMetadata, AgentBackend};
use super::execution_context::{IsolationDomainKey, ProcessEnvRevision};
use super::{AgentLaunchConfig, PermissionPolicy, RuntimeManager};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CapturedAttach {
    pub(crate) domain: IsolationDomainKey,
    pub(crate) working_directory: PathBuf,
    pub(crate) process_env_revision: ProcessEnvRevision,
    pub(crate) extra_env: HashMap<String, String>,
}

struct CapturingBackend {
    captures: Arc<Mutex<Vec<CapturedAttach>>>,
}

#[async_trait::async_trait]
impl AgentBackend for CapturingBackend {
    async fn attach_session(
        &mut self,
        _agent_type: crate::proto::amux::AgentType,
        _launch: &AgentLaunchConfig,
        domain: IsolationDomainKey,
        process_env_revision: ProcessEnvRevision,
        extra_env: HashMap<String, String>,
        _force_env_override: bool,
        worktree: String,
        _resume_acp_session_id: Option<String>,
        _mcp_config_path: Option<PathBuf>,
        _initial_model_override: Option<String>,
        _model_mru: Vec<String>,
        _initial_prompt: String,
        _event_tx: mpsc::Sender<AcpEventFrame>,
        _permission: PermissionPolicy,
        _forbid_new_session_fallback: bool,
    ) -> crate::error::Result<(mpsc::Sender<AcpCommand>, AcpStartupMetadata)> {
        self.captures.lock().unwrap().push(CapturedAttach {
            domain,
            working_directory: worktree.into(),
            process_env_revision,
            extra_env,
        });
        let (tx, _rx) = mpsc::channel(1);
        Ok((
            tx,
            AcpStartupMetadata {
                available_models: Vec::new(),
                initial_model: None,
                acp_session_id: format!("captured-{}", self.captures.lock().unwrap().len()),
                host_generation_id: String::new(),
                route_lease: None,
            },
        ))
    }

    async fn prewarm(
        &mut self,
        _configs: &HashMap<crate::proto::amux::AgentType, AgentLaunchConfig>,
    ) {
    }

    async fn prewarm_with_env(
        &mut self,
        _configs: &HashMap<crate::proto::amux::AgentType, AgentLaunchConfig>,
        _extra_env: HashMap<String, String>,
        _force_env_override: bool,
        _workspace_path: Option<&str>,
    ) {
    }

    fn evict_agent_types(&mut self, _types: &[crate::proto::amux::AgentType]) -> usize {
        0
    }

    fn host_count(&self) -> usize {
        0
    }

    async fn model_catalog(
        &mut self,
        _workspace_path: &std::path::Path,
    ) -> crate::error::Result<Vec<crate::proto::amux::ModelInfo>> {
        Ok(Vec::new())
    }
}

pub(crate) fn install_capturing_backend(
    manager: &mut RuntimeManager,
) -> Arc<Mutex<Vec<CapturedAttach>>> {
    let captures = Arc::new(Mutex::new(Vec::new()));
    manager.agent_backend = Arc::new(tokio::sync::Mutex::new(Box::new(CapturingBackend {
        captures: captures.clone(),
    })));
    captures
}

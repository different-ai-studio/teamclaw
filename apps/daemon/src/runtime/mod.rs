pub mod acp_event_frame;
pub mod backend;
pub mod opencode_http;
pub mod pi_rpc;
// Compatibility alias: external modules still reach the runtime backend as
// `crate::runtime::adapter` (AcpCommand, AcpStartupMetadata, envelopes, …).
pub use self::opencode_http as adapter;
mod agent_runtime_state;
mod agent_trace;
pub mod env_assembly;
mod handle;
mod instruction_delivery;
pub mod managed_llm;
mod manager;
pub mod models;
pub mod refresh;
pub mod supervisor;
pub mod turn_aggregator;
mod workspace_runtime;

pub use backend::{create_backend, AgentBackend, OpencodeHttpBackend};
pub use handle::{InjectedContextItem, PendingMessage, RuntimeHandle};
pub use instruction_delivery::{
    resolve_instruction_delivery, skips_buffered_inject, InstructionDelivery,
};
pub use manager::{AgentLaunchConfig, CheckedOutTurn, RuntimeManager, SpawnRuntimeEnv};
// Kept importable for external callers/tests even though in-crate code now
// goes through `AgentBackend`.
#[allow(unused_imports)]
pub use opencode_http::AcpHostPool;
pub use supervisor::RuntimeSupervisor;
pub use workspace_runtime::{apply_workspace_system_instructions, instruction_plugin_installed};

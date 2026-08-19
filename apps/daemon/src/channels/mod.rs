pub mod agent_handle;
pub mod backend_store;
/// Prototype of the one channel→session pipeline
/// (`docs/specs/2026-08-18-gateway-transport-architecture.md`). Not wired into
/// gateway boot yet; it exists to pin the stage order and downgrade rules.
pub mod core;
pub mod live_notify;
mod bot_prompt_file;
pub mod manager;
pub mod reply_token;
pub mod wecom_mcp;
pub use agent_handle::{AmuxdAgentHandle, BotRuntimeConfig, GatewaySpawnEnv};
pub use backend_store::AmuxdChannelStore;
pub use manager::ChannelManager;

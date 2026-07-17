mod daemon_config;
mod member_store;
mod roles_skills;
mod workspace_instructions;
pub mod team_mcp;
mod session_store;
mod workspace_resolver;
pub mod global_team_store;
pub mod workspace_link;
pub mod workspace_path;
pub mod provider_auth;
pub mod workspace_control;

pub use daemon_config::{
    AgentBackendConfig, AgentsConfig, ActorConfig, DaemonConfig, DiscordChannel, EmailChannel,
    FeishuChannel, HttpConfig, KookChannel, MqttConfig, TransportKind, WeChatChannel, WeComChannel,
    BOOTSTRAP_ACTOR_NAME,
};
// Constructed only by the test suite (runtime_resolution / server tests).
#[cfg(test)]
pub use daemon_config::ChannelsConfig;
pub use member_store::{MemberStore, PendingInvite, StoredMember};
pub use session_store::{SessionStore, StoredSession};
pub use workspace_resolver::{
    resolve_default_workspace_path, ResolveError, ResolvedWorkspace, WorkspaceResolver,
};
pub use roles_skills::{
    scan_roles_skills_state, ManagedSkillDto, RoleRecordDto, RoleSkillLinkDto,
    RolesSkillsMetricsDto, RolesSkillsStateDto,
};
pub use provider_auth::{
    builtin_provider_auth_methods, merge_live_provider_auth_methods, ProviderAuthMethod,
    ProviderAuthMethodType, ProviderAuthMethodsResponse,
};
pub use workspace_instructions::{
    claude_md_block_present_at, load_system_prompt, sync_teamclaw_claude_md,
};
pub use workspace_control::{
    decode_workspace_path, AllowlistDecision, AllowlistRule, ApplyOutcome, McpServerConfig, NullWorkspaceControlStore,
    OpenCodeCompatStore, PermissionAction, PermissionConfig, ProviderAuthRequest,
    ProviderInfo, ProviderModelConfig, RuntimeStatus, WorkspaceControlError,
    WorkspaceControlStore,
};

// Pasted at the integration-test crate root via `include!`.
// Paths are relative to this file (`tests/support/crate_modules.rs`).

#[path = "../../src/backend/mod.rs"]
mod backend;
#[path = "../../src/config/mod.rs"]
mod config;
#[path = "../../src/error.rs"]
mod error;
#[path = "../../src/http/mod.rs"]
mod http;
#[path = "../../src/mcp_probe.rs"]
mod mcp_probe;
#[path = "../../src/opencode_settings/mod.rs"]
mod opencode_settings;
#[path = "../../src/proto.rs"]
mod proto;
#[path = "../../src/provider_config.rs"]
mod provider_config;
#[path = "../../src/runtime/mod.rs"]
mod runtime;
#[path = "../../src/sync/mod.rs"]
mod sync;
#[path = "../../src/team_link.rs"]
mod team_link;
#[path = "../../src/team_shared_env.rs"]
mod team_shared_env;
#[path = "../../src/team_shared_git.rs"]
mod team_shared_git;

fn test_sync_dispatcher() -> sync::dispatch::SyncDispatcher {
    sync::dispatch::SyncDispatcher::new(sync::secret_store::SecretStore::new(), None)
}

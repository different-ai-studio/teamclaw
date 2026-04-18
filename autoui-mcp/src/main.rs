mod config;
mod keyboard;
mod keys;
mod mcp;
mod mouse;
mod screenshot;
mod vision;

use anyhow::Result;
use rmcp::{transport::stdio, ServiceExt};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging to stderr (stdout is reserved for MCP JSON-RPC)
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let config = config::Config::from_env();
    tracing::info!("Starting AutoUI MCP Server v{}", env!("CARGO_PKG_VERSION"));
    tracing::info!(
        vision_enabled = config.has_vision(),
        model = config.vision_model.as_str(),
        "Configuration loaded"
    );

    // Start MCP stdio server
    let service = mcp::AutoUiService::new(config);
    let server = service.serve(stdio()).await?;
    server.waiting().await?;

    Ok(())
}

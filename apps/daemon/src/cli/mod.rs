pub mod clear;
pub mod process;
pub mod test_client;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "amuxd", version, about = "AMUX Agent Multiplexer Daemon")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Start the daemon (writes ~/.config/amux/amuxd.pid while running).
    Start {
        #[arg(short, long)]
        daemonize: bool,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Stop the running daemon (SIGTERM via pidfile).
    Stop,
    /// Show daemon status (reads the pidfile).
    Status,
    /// Onboard this daemon. Without args, walks you through the iOS side
    /// and prompts you to paste the deeplink. Pass the URL to skip the
    /// interactive prompt (useful for scripts).
    Init {
        /// `amux://invite?token=...` URL from the iOS Actors tab.
        join_url: Option<String>,
    },
    /// Delete local daemon state (daemon.toml, members.toml, sessions.toml,
    /// supabase.toml, workspaces.toml). Use before running `init` against a
    /// different team or after revoking access.
    Clear {
        /// Skip the interactive confirmation prompt.
        #[arg(long)]
        force: bool,
    },
    /// Test: spawn claude and print parsed events (for development)
    TestSpawn {
        /// Prompt to send
        prompt: String,
        /// Working directory
        #[arg(long, default_value = ".")]
        worktree: String,
    },
    /// Test: simulate an iOS client — connect to broker, send commands, watch events
    TestClient {
        /// Config file path (uses same daemon.toml)
        #[arg(long)]
        config: Option<std::path::PathBuf>,
        #[command(subcommand)]
        action: TestClientAction,
    },
}

#[derive(Subcommand)]
pub enum TestClientAction {
    /// Watch all events from the daemon (subscribe to all topics)
    Watch,
    /// Send a StartAgent command
    StartAgent { worktree: String, prompt: String },
    /// Send a PeerAnnounce (authenticate with token)
    Announce { token: String },
    /// Full E2E: announce → start agent → watch events (single connection)
    E2e {
        token: String,
        worktree: String,
        prompt: String,
    },
}

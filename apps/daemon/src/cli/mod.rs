pub mod channel;
pub mod clear;
pub mod config_cmd;
pub mod doctor;
pub mod install_opencode;
pub mod mcp_server;
pub mod process;
pub mod remote_tools_mcp;
pub mod service;
pub mod test_client;

use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "amuxd", version, about = "AMUX Agent Multiplexer Daemon")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Start the daemon (writes ~/.amuxd/amuxd.pid while running).
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
        /// `teamclaw://invite?token=...` URL from the iOS Actors tab.
        join_url: Option<String>,
    },
    /// Delete local daemon state (daemon.toml, members.toml, sessions.toml,
    /// backend.toml, workspaces.toml). Use before running `init` against a
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
    /// Manage channel bindings (discord, wecom, feishu, kook, wechat, email).
    Channel(ChannelArgs),
    /// Read and edit daemon.toml values by dotted key.
    Config(ConfigArgs),
    /// Report install status of opencode / git / amuxd as JSON.
    Doctor,
    /// Download and install the opencode binary into ~/.amuxd/bin/opencode.
    InstallOpencode {
        /// Reinstall even if the locked version is already present.
        #[arg(long)]
        force: bool,
    },
    /// Register amuxd as a user-level background service (launchd / systemd-user / scheduled task) and start it.
    InstallService,
    /// Stop and remove the amuxd background service.
    UninstallService,
    /// Run the MCP (Model Context Protocol) server on stdio. Spawned by
    /// claude-code via `--mcp-config`; bridges tool calls to amuxd over
    /// `amuxd.sock`. Exposes a single `send` tool that lets the agent
    /// proactively send messages/files to the gateway chat its session is
    /// bound to.
    McpServer(McpServerArgs),
    /// Run the remote-tools MCP server on stdio. Proxies browser/client tools
    /// to the bound TeamClaw client over MQTT RPC.
    RemoteToolsMcp(RemoteToolsMcpArgs),
}

#[derive(Args, Debug)]
pub struct ConfigArgs {
    /// Config file path. Defaults to `~/.amuxd/daemon.toml`.
    #[arg(long)]
    pub config: Option<PathBuf>,
    #[command(subcommand)]
    pub action: ConfigAction,
}

#[derive(Subcommand, Debug)]
pub enum ConfigAction {
    /// Print the config file path that would be used.
    Path,
    /// List all scalar config values as dotted keys.
    List,
    /// Print one config value by dotted key.
    Get { key: String },
    /// Set one config value by dotted key. Values are parsed as TOML literals;
    /// invalid literals are written as strings.
    Set { key: String, value: String },
    /// Remove one config value by dotted key.
    Unset { key: String },
}

#[derive(Args, Debug)]
pub struct McpServerArgs {
    /// AMUX session_id this MCP server is bound to. Defaulted tool calls
    /// will route messages back to this session's gateway chat.
    #[arg(long)]
    pub session_id: String,
    /// Binding URI (e.g. `wecom://{corp_id}/{agent_id}/single/{userid}`).
    /// Determines the default channel + target for the `send` tool when
    /// the agent omits explicit overrides.
    #[arg(long)]
    pub binding: String,
    /// Override path to `amuxd.sock`. Defaults to
    /// `DaemonConfig::sock_path()` (`~/.amuxd/amuxd.sock`).
    #[arg(long)]
    pub sock: Option<std::path::PathBuf>,
}

#[derive(Args, Debug)]
pub struct RemoteToolsMcpArgs {
    #[arg(long, default_value = "")]
    pub session_id: String,
    #[arg(long, default_value = "")]
    pub team_id: String,
    /// Member actor that owns the RPC topic (`amux/{team}/{id}/rpc/req`).
    #[arg(long, alias = "client-actor-id", default_value = "")]
    pub member_actor_id: String,
    #[arg(long)]
    pub sock: Option<std::path::PathBuf>,
}

#[derive(Args, Debug)]
pub struct ChannelArgs {
    #[command(subcommand)]
    pub action: ChannelAction,
}

#[derive(Subcommand, Debug)]
pub enum ChannelAction {
    /// List all channels and their enabled state.
    List,
    /// Bind a channel (per-platform credentials).
    Bind(ChannelBindArgs),
    /// Remove a channel binding.
    Unbind { platform: String },
    /// Verify channel credentials are configured.
    Test { platform: String },
    /// Signal a running amuxd to re-read channel config.
    Reload,
}

#[derive(Args, Debug)]
pub struct ChannelBindArgs {
    #[command(subcommand)]
    pub platform: ChannelBindPlatform,
}

#[derive(Subcommand, Debug)]
pub enum ChannelBindPlatform {
    /// Bind a Discord bot.
    Discord {
        #[arg(long)]
        bot_token: String,
        #[arg(long)]
        default_username: Option<String>,
    },
    /// Bind a WeCom bot.
    Wecom {
        #[arg(long)]
        bot_id: String,
        #[arg(long)]
        secret: String,
        #[arg(long)]
        encoding_aes_key: Option<String>,
    },
    /// Bind a Feishu app.
    Feishu {
        #[arg(long)]
        app_id: String,
        #[arg(long)]
        app_secret: String,
    },
    /// Bind a Kook bot.
    Kook {
        #[arg(long)]
        bot_token: String,
    },
    /// Bind a WeChat (iLink) account.
    Wechat {
        #[arg(long)]
        ilink_account: String,
        #[arg(long)]
        ilink_token: String,
    },
    /// Bind an Email (IMAP/SMTP) channel.
    Email {
        #[arg(long)]
        imap_host: String,
        #[arg(long)]
        imap_port: u16,
        #[arg(long)]
        imap_user: String,
        #[arg(long)]
        imap_pass: String,
        #[arg(long)]
        smtp_host: String,
        #[arg(long)]
        smtp_port: u16,
        #[arg(long)]
        smtp_user: String,
        #[arg(long)]
        smtp_pass: String,
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

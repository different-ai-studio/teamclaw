mod agent_discover;
mod backend;
mod channels;
mod cli;
mod collab;
mod config;
mod daemon;
mod device_id;
mod error;
mod history;
mod http;
mod mcp_probe;
mod mqtt;
mod nats;
mod onboarding;
mod opencode_install;
mod opencode_settings;
mod proto;
mod provider_config;
mod remote_tools;
mod runtime;
mod service;
mod sync;
mod team_link;
mod team_shared_env;
mod team_shared_git;
mod teamclaw;

use clap::Parser;
use cli::{Cli, Commands, TestClientAction};

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Setup { print_only } => {
            cli::setup::run(print_only)?;
        }
        Commands::Init { join_url } => {
            let url = match join_url {
                Some(u) => u,
                None => prompt_for_invite_url()?,
            };
            let rt = tokio::runtime::Runtime::new()?;
            let outcome = rt.block_on(onboarding::init::run(&url, None))?;
            println!(
                "\n✓ Daemon onboarded.\n  actor_id      = {}\n  team_id       = {}\n  display_name  = {}\n  backend.toml  = {}\n\nNext: `amuxd start`",
                outcome.actor_id,
                outcome.team_id,
                outcome.display_name,
                outcome.config_path.display()
            );
        }
        Commands::Clear { force } => {
            cli::clear::run(force)?;
        }
        Commands::Team(args) => {
            cli::team_secrets::run(args)?;
        }
        Commands::Start {
            daemonize: _,
            config,
        } => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive("amuxd=info".parse().unwrap()),
                )
                .init();

            let config_path = config.unwrap_or_else(config::DaemonConfig::default_path);
            // Absent config bootstraps rather than failing: a fresh install must
            // be able to start and serve the setup UI that configures it.
            let mut daemon_config = config::DaemonConfig::load_or_bootstrap(&config_path)?;
            if let Err(e) = agent_discover::discover_and_persist(&mut daemon_config, &config_path) {
                tracing::warn!("agent auto-discovery failed: {e}");
            }

            let _daemon_lock = cli::process::acquire_daemon_lock()?;
            cli::process::write_pidfile()?;
            let _pid_guard = PidfileGuard;

            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                let server = daemon::DaemonServer::new(daemon_config, &config_path).await?;
                // run() owns the shutdown signal so it can gracefully tear
                // down channels (consuming `ChannelManager::shutdown(self)`)
                // before returning. Dropping the run() future mid-loop via
                // an external select would skip that teardown.
                server.run(shutdown_signal()).await
            })?;
        }
        Commands::InstallService => {
            cli::service::install()?;
        }
        Commands::UninstallService => {
            cli::service::uninstall()?;
        }
        Commands::Stop => {
            cli::process::run_stop()?;
        }
        Commands::Status => {
            cli::process::run_status()?;
        }
        Commands::TestSpawn { prompt, worktree } => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive("amuxd=debug".parse().unwrap()),
                )
                .init();

            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                let (tx, mut rx) = tokio::sync::mpsc::channel(256);
                let binary = "claude".to_string();
                println!(
                    "Spawning ACP agent: {} with prompt \"{}\" in {}",
                    binary, prompt, worktree
                );

                let (startup_tx, _startup_rx) = tokio::sync::oneshot::channel::<
                    Result<runtime::adapter::AcpStartupMetadata, String>,
                >();
                let _cmd_tx = runtime::adapter::spawn_acp_agent(
                    binary,
                    Vec::new(),
                    worktree.clone(),
                    prompt.clone(),
                    proto::amux::AgentType::ClaudeCode,
                    tx,
                    None,
                    startup_tx,
                    None,
                    None,
                    std::collections::HashMap::new(),
                )?;

                println!("--- Streaming events (Ctrl+C to stop) ---\n");
                let mut count = 0u32;
                while let Some(frame) = rx.recv().await {
                    count += 1;
                    match &frame.event.event {
                        Some(proto::amux::acp_event::Event::Output(o)) => {
                            print!("{}", o.text);
                        }
                        Some(proto::amux::acp_event::Event::Thinking(t)) => {
                            println!(
                                "\n[THINKING] {}",
                                if t.text.len() > 100 {
                                    &t.text[..100]
                                } else {
                                    &t.text
                                }
                            );
                        }
                        Some(proto::amux::acp_event::Event::ToolUse(tu)) => {
                            println!("\n[TOOL] {} ({})", tu.tool_name, tu.tool_id);
                        }
                        Some(proto::amux::acp_event::Event::ToolResult(tr)) => {
                            println!(
                                "[TOOL RESULT] success={} summary={}",
                                tr.success,
                                if tr.summary.len() > 80 {
                                    &tr.summary[..80]
                                } else {
                                    &tr.summary
                                }
                            );
                        }
                        Some(proto::amux::acp_event::Event::StatusChange(sc)) => {
                            println!("\n[STATUS] {:?} -> {:?}", sc.old_status, sc.new_status);
                        }
                        Some(proto::amux::acp_event::Event::Error(e)) => {
                            println!("\n[ERROR] {}", e.message);
                        }
                        _ => {
                            println!("\n[OTHER EVENT]");
                        }
                    }
                }

                println!("\n\n--- Done. {} events received ---", count);
                Ok::<(), anyhow::Error>(())
            })?;
        }
        Commands::Doctor => {
            cli::doctor::run()?;
        }
        Commands::InstallOpencode { force } => {
            cli::install_opencode::run(force)?;
        }
        Commands::Channel(args) => {
            let path = config::DaemonConfig::default_path();
            cli::channel::run(args, &path)?;
        }
        Commands::Config(args) => {
            let path = config::DaemonConfig::default_path();
            cli::config_cmd::run(args, &path)?;
        }
        Commands::McpServer(args) => {
            let sock = args
                .sock
                .clone()
                .unwrap_or_else(config::DaemonConfig::sock_path);
            cli::mcp_server::run(&args.session_id, &args.binding, &sock)?;
        }
        Commands::RemoteToolsMcp(args) => {
            let sock = args
                .sock
                .clone()
                .unwrap_or_else(config::DaemonConfig::sock_path);
            let _ = (&args.session_id, &args.team_id, &args.member_actor_id);
            cli::remote_tools_mcp::run(&sock)?;
        }
        Commands::TestClient { config, action } => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive("amuxd=info".parse().unwrap()),
                )
                .init();

            let config_path = config.unwrap_or_else(config::DaemonConfig::default_path);
            let mut daemon_config = config::DaemonConfig::load(&config_path)?;
            if let Err(e) = agent_discover::discover_and_persist(&mut daemon_config, &config_path) {
                tracing::warn!("agent auto-discovery failed: {e}");
            }

            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                match action {
                    TestClientAction::Watch => cli::test_client::run_watch(daemon_config).await?,
                    TestClientAction::StartAgent { worktree, prompt } => {
                        cli::test_client::run_start_agent(daemon_config, &worktree, &prompt)
                            .await?;
                    }
                    TestClientAction::Announce { token } => {
                        cli::test_client::run_announce(daemon_config, &token).await?;
                    }
                    TestClientAction::E2e {
                        token,
                        worktree,
                        prompt,
                    } => {
                        cli::test_client::run_e2e(daemon_config, &token, &worktree, &prompt)
                            .await?;
                    }
                }
                Ok::<(), anyhow::Error>(())
            })?;
        }
    }

    Ok(())
}

/// RAII guard: removes the pidfile when the daemon's main scope exits
/// (either from a clean shutdown or a panic that unwinds main).
struct PidfileGuard;
impl Drop for PidfileGuard {
    fn drop(&mut self) {
        cli::process::remove_pidfile();
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = term.recv() => {},
        _ = int.recv()  => {},
    }
}

/// Windows: Ctrl-C / console-close. Service-style stops arrive as the
/// `shutdown` control command instead (SockCommand::Shutdown in the run loop).
#[cfg(windows)]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

/// Print onboarding instructions and block on stdin for the deeplink the
/// user copies from the iOS app's Actors tab.
fn prompt_for_invite_url() -> anyhow::Result<String> {
    use std::io::{BufRead, Write};

    println!("amuxd onboarding — register this daemon as an agent on your TeamClaw team.");
    println!();
    println!("  1. Install the AMUX iOS app and sign in.");
    println!("  2. Create a team (if you haven't already).");
    println!("  3. Open the Actors tab → tap the + icon in the top right.");
    println!("  4. Pick kind = Agent, set a display name, tap Confirm.");
    println!("  5. Copy the generated `teamclaw://invite?...` deeplink.");
    println!();
    print!("Paste the deeplink here (or Ctrl-C to abort): ");
    std::io::stdout().flush()?;

    let stdin = std::io::stdin();
    let mut line = String::new();
    stdin.lock().read_line(&mut line)?;
    let trimmed: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    if trimmed.is_empty() {
        anyhow::bail!("no deeplink provided");
    }
    Ok(trimmed)
}

mod channels;
mod cli;
mod collab;
mod config;
mod daemon;
mod error;
mod history;
mod mqtt;
mod onboarding;
mod proto;
mod runtime;
mod supabase;
mod teamclaw;

use clap::Parser;
use cli::{Cli, Commands, TestClientAction};

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { join_url } => {
            let url = match join_url {
                Some(u) => u,
                None => prompt_for_invite_url()?,
            };
            let rt = tokio::runtime::Runtime::new()?;
            let outcome = rt.block_on(onboarding::init::run(&url, None))?;
            println!(
                "\n✓ Daemon onboarded.\n  actor_id      = {}\n  team_id       = {}\n  display_name  = {}\n  supabase.toml = {}\n\nNext: `amuxd start`",
                outcome.actor_id,
                outcome.team_id,
                outcome.display_name,
                outcome.config_path.display()
            );
        }
        Commands::Clear { force } => {
            cli::clear::run(force)?;
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
            let daemon_config = config::DaemonConfig::load(&config_path)?;

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

                let (initial_model_tx, _initial_model_rx) =
                    tokio::sync::oneshot::channel::<Option<String>>();
                let (acp_session_id_tx, _acp_session_id_rx) =
                    tokio::sync::oneshot::channel::<String>();
                let _cmd_tx = runtime::adapter::spawn_acp_agent(
                    binary,
                    worktree.clone(),
                    prompt.clone(),
                    proto::amux::AgentType::ClaudeCode,
                    tx,
                    initial_model_tx,
                    None,
                    acp_session_id_tx,
                )?;

                println!("--- Streaming events (Ctrl+C to stop) ---\n");
                let mut count = 0u32;
                while let Some(event) = rx.recv().await {
                    count += 1;
                    match &event.event {
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
        Commands::TestClient { config, action } => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive("amuxd=info".parse().unwrap()),
                )
                .init();

            let config_path = config.unwrap_or_else(config::DaemonConfig::default_path);
            let daemon_config = config::DaemonConfig::load(&config_path)?;

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

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
    tokio::select! {
        _ = term.recv() => {},
        _ = int.recv()  => {},
    }
}

/// Print onboarding instructions and block on stdin for the deeplink the
/// user copies from the iOS app's Actors tab.
fn prompt_for_invite_url() -> anyhow::Result<String> {
    use std::io::{BufRead, Write};

    println!("amuxd onboarding — register this daemon as an agent on your Supabase team.");
    println!();
    println!("  1. Install the AMUX iOS app and sign in.");
    println!("  2. Create a team (if you haven't already).");
    println!("  3. Open the Actors tab → tap the + icon in the top right.");
    println!("  4. Pick kind = Agent, set a display name, tap Confirm.");
    println!("  5. Copy the generated `amux://invite?...` deeplink.");
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

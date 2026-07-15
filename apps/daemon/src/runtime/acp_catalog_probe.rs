//! One-shot ACP `session/new` probe to list models for automation UIs (cron catalog).
//!
//! OpenCode advertises models via `configOptions[id=model]`, not `SessionModelState`.
//! Reuses `models::resolve_available_models` so the catalog matches runtime attach.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

use acp::Agent as _;
use agent_client_protocol as acp;
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use tracing::warn;

use crate::proto::amux;

struct NullClient;

#[async_trait::async_trait(?Send)]
impl acp::Client for NullClient {
    async fn request_permission(
        &self,
        _: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn write_text_file(
        &self,
        _: acp::WriteTextFileRequest,
    ) -> acp::Result<acp::WriteTextFileResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn read_text_file(
        &self,
        _: acp::ReadTextFileRequest,
    ) -> acp::Result<acp::ReadTextFileResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn create_terminal(
        &self,
        _: acp::CreateTerminalRequest,
    ) -> acp::Result<acp::CreateTerminalResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn terminal_output(
        &self,
        _: acp::TerminalOutputRequest,
    ) -> acp::Result<acp::TerminalOutputResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn release_terminal(
        &self,
        _: acp::ReleaseTerminalRequest,
    ) -> acp::Result<acp::ReleaseTerminalResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn wait_for_terminal_exit(
        &self,
        _: acp::WaitForTerminalExitRequest,
    ) -> acp::Result<acp::WaitForTerminalExitResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn kill_terminal(
        &self,
        _: acp::KillTerminalRequest,
    ) -> acp::Result<acp::KillTerminalResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn session_notification(&self, _: acp::SessionNotification) -> acp::Result<()> {
        Ok(())
    }
    async fn ext_method(&self, _: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
        Err(acp::Error::method_not_found())
    }
    async fn ext_notification(&self, _: acp::ExtNotification) -> acp::Result<()> {
        Ok(())
    }
}

fn opencode_acp_command(binary: &str, args: &[String]) -> Command {
    let mut cmd = if args.is_empty() {
        let mut c = Command::new(binary);
        c.arg("acp");
        c
    } else {
        let mut c = Command::new(binary);
        c.args(args);
        c
    };
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    cmd
}

/// Spawn a short-lived OpenCode ACP session and return the model list the agent
/// advertises (same resolution path as `attach_acp_session_on_conn`).
pub async fn probe_opencode_models_at_cwd(
    binary: &str,
    args: &[String],
    cwd: PathBuf,
    extra_env: HashMap<String, String>,
) -> anyhow::Result<Vec<amux::ModelInfo>> {
    let (tx, rx) = oneshot::channel();
    let binary = binary.to_string();
    let args = args.to_vec();

    std::thread::Builder::new()
        .name("acp-catalog-probe".into())
        .spawn(move || {
            let result = run_probe_thread(binary, args, cwd, extra_env);
            let _ = tx.send(result);
        })
        .map_err(|e| anyhow::anyhow!("failed to spawn catalog probe thread: {e}"))?;

    tokio::time::timeout(std::time::Duration::from_secs(45), rx)
        .await
        .map_err(|_| anyhow::anyhow!("opencode ACP model catalog probe timed out"))?
        .map_err(|_| anyhow::anyhow!("catalog probe thread dropped"))?
}

fn run_probe_thread(
    binary: String,
    args: Vec<String>,
    cwd: PathBuf,
    extra_env: HashMap<String, String>,
) -> anyhow::Result<Vec<amux::ModelInfo>> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async move {
        let mut cmd = opencode_acp_command(&binary, &args);
        cmd.current_dir(&cwd);
        for (key, value) in &extra_env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("no stdout"))?;

        let outgoing = stdin.compat_write();
        let incoming = stdout.compat();

        let local = tokio::task::LocalSet::new();
        let models = local
            .run_until(async move {
                let (conn, io) = acp::ClientSideConnection::new(
                    NullClient {},
                    outgoing,
                    incoming,
                    |f| {
                        tokio::task::spawn_local(f);
                    },
                );
                tokio::task::spawn_local(io);

                let _init = conn
                    .initialize(
                        acp::InitializeRequest::new(acp::ProtocolVersion::V1).client_info(
                            acp::Implementation::new("amuxd-catalog-probe", "0.0.0")
                                .title("TeamClaw catalog probe"),
                        ),
                    )
                    .await?;

                let resp = conn.new_session(acp::NewSessionRequest::new(cwd)).await?;
                let models = super::models::resolve_available_models(
                    amux::AgentType::Opencode,
                    resp.models.as_ref(),
                    resp.config_options.as_deref(),
                );
                Ok::<Vec<amux::ModelInfo>, anyhow::Error>(models)
            })
            .await?;

        if let Err(e) = child.kill().await {
            warn!(error = %e, "failed to kill catalog probe child");
        }
        let _ = child.wait().await;

        Ok(models)
    })
}

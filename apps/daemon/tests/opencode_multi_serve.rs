//! Real-binary prerequisite for workspace-scoped OpenCode serve processes.
//!
//! This test intentionally keeps OpenCode's normal user data and config roots.
//! It is ignored because it uses the user's configured provider and performs
//! real model/tool calls.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use reqwest::{Method, Response};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const BASIC_AUTH_USER: &str = "opencode";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

struct SpikeServe {
    base_url: String,
    password: String,
    child: Child,
    http: reqwest::Client,
    diagnostics: Arc<Mutex<Vec<String>>>,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
}

impl SpikeServe {
    async fn spawn(binary: &str, sentinel: &str) -> Result<Self> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .context("bind loopback listener for OpenCode spike")?;
        let port = listener.local_addr()?.port();
        drop(listener);

        let password = uuid::Uuid::new_v4().simple().to_string();
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let mut command = Command::new(binary);
        command
            .arg("serve")
            .arg("--hostname")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .env("TEAMCLU_HOST_POOL_SPIKE_SENTINEL", sentinel)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command
            .spawn()
            .with_context(|| format!("spawn {binary} serve"))?;
        let stderr_task = child.stderr.take().map(|stderr| {
            let captured = Arc::clone(&diagnostics);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    captured.lock().unwrap().push(line);
                }
            })
        });

        let serve = Self {
            base_url: format!("http://127.0.0.1:{port}"),
            password,
            child,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?,
            diagnostics,
            stderr_task,
        };
        serve.wait_until_healthy().await?;
        Ok(serve)
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        directory: Option<&Path>,
    ) -> reqwest::RequestBuilder {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base_url, path))
            .basic_auth(BASIC_AUTH_USER, Some(&self.password));
        if let Some(directory) = directory {
            request = request.query(&[("directory", directory.to_string_lossy().as_ref())]);
        }
        request
    }

    async fn checked(response: Response, operation: &str) -> Result<Response> {
        if response.status().is_success() {
            Ok(response)
        } else {
            bail!("{operation} failed with HTTP {}", response.status())
        }
    }

    async fn wait_until_healthy(&self) -> Result<()> {
        let started = Instant::now();
        while started.elapsed() < HEALTH_TIMEOUT {
            if self.health().await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        bail!("OpenCode serve health check timed out")
    }

    async fn health(&self) -> bool {
        self.request(Method::GET, "/global/health", None)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }

    async fn create_session(&self, directory: &Path) -> Result<String> {
        let response = self
            .request(Method::POST, "/session", Some(directory))
            .json(&json!({}))
            .send()
            .await?;
        let body: Value = Self::checked(response, "create session")
            .await?
            .json()
            .await?;
        body.get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("create session response had no id"))
    }

    async fn prompt_for_sentinel(
        &self,
        directory: &Path,
        session_id: &str,
        model: &str,
    ) -> Result<String> {
        let (provider_id, model_id) = model
            .split_once('/')
            .ok_or_else(|| anyhow!("TEAMCLU_OPENCODE_SPIKE_MODEL must be provider/model"))?;
        if provider_id.is_empty() || model_id.is_empty() {
            bail!("TEAMCLU_OPENCODE_SPIKE_MODEL must be provider/model");
        }

        // Subscribe before prompting so permission, tool, and idle events cannot
        // race ahead of the test harness.
        let event_response = self
            .request(Method::GET, "/event", Some(directory))
            .timeout(Duration::from_secs(u64::MAX / 4))
            .send()
            .await?;
        let event_response = Self::checked(event_response, "subscribe to events").await?;
        let mut stream = event_response.bytes_stream();

        let prompt = concat!(
            "Use the shell tool exactly once to run this command: ",
            "printf '%s\\n' \"$TEAMCLU_HOST_POOL_SPIKE_SENTINEL\". ",
            "Do not infer the value and do not substitute assistant prose for the tool call."
        );
        let response = self
            .request(
                Method::POST,
                &format!("/session/{session_id}/prompt_async"),
                Some(directory),
            )
            .json(&json!({
                "model": {
                    "providerID": provider_id,
                    "modelID": model_id,
                },
                "parts": [{
                    "type": "text",
                    "text": prompt,
                }],
            }))
            .send()
            .await?;
        Self::checked(response, "prompt session").await?;

        let deadline = Instant::now() + TURN_TIMEOUT;
        let mut buffer = Vec::new();
        let mut tool_output = None;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                bail!("timed out waiting for OpenCode tool result");
            }
            let next = tokio::time::timeout(remaining, stream.next())
                .await
                .context("timed out waiting for OpenCode SSE")?
                .ok_or_else(|| anyhow!("OpenCode SSE ended before session idle"))??;
            buffer.extend_from_slice(&next);

            while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = buffer.drain(..=position).collect();
                let line = String::from_utf8_lossy(&line);
                let Some(payload) = line.trim_end().strip_prefix("data:").map(str::trim_start)
                else {
                    continue;
                };
                let Ok(event) = serde_json::from_str::<Value>(payload) else {
                    continue;
                };

                reject_cross_session_event(&event, session_id)?;
                let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
                let properties = event.get("properties").unwrap_or(&Value::Null);
                if event_type == "permission.asked"
                    && event_session_id(&event).as_deref() == Some(session_id)
                {
                    let permission_id = properties
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("permission event had no id"))?;
                    let response = self
                        .request(
                            Method::POST,
                            &format!("/session/{session_id}/permissions/{permission_id}"),
                            Some(directory),
                        )
                        .json(&json!({ "response": "once" }))
                        .send()
                        .await?;
                    Self::checked(response, "approve test shell permission").await?;
                }

                if event_type == "message.part.updated" {
                    if let Some(output) = completed_tool_output(properties, session_id) {
                        tool_output = Some(output);
                    }
                }
                if event_type == "session.idle"
                    && event_session_id(&event).as_deref() == Some(session_id)
                {
                    return tool_output
                        .ok_or_else(|| anyhow!("session completed without a tool result"));
                }
            }
        }
    }

    async fn resume_and_prompt(
        &self,
        directory: &Path,
        session_id: &str,
        model: &str,
    ) -> Result<String> {
        let response = self
            .request(
                Method::GET,
                &format!("/session/{session_id}"),
                Some(directory),
            )
            .send()
            .await?;
        if !response.status().is_success() {
            bail!(
                "restarted host could not resume session: HTTP {}",
                response.status()
            );
        }
        self.prompt_for_sentinel(directory, session_id, model).await
    }

    fn rss_mib(&self) -> Result<f64> {
        let pid = self
            .child
            .id()
            .ok_or_else(|| anyhow!("OpenCode child has no pid"))?;
        #[cfg(target_os = "linux")]
        {
            let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
            let rss_kib = status
                .lines()
                .find_map(|line| line.strip_prefix("VmRSS:"))
                .and_then(|value| value.split_whitespace().next())
                .ok_or_else(|| anyhow!("VmRSS missing for OpenCode child"))?
                .parse::<f64>()?;
            return Ok(rss_kib / 1024.0);
        }
        #[cfg(not(target_os = "linux"))]
        {
            let output = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &pid.to_string()])
                .output()?;
            if !output.status.success() {
                bail!("ps failed while measuring OpenCode RSS");
            }
            let rss_kib = String::from_utf8(output.stdout)?.trim().parse::<f64>()?;
            Ok(rss_kib / 1024.0)
        }
    }

    fn assert_no_lock_or_corruption(&self) -> Result<()> {
        let diagnostics = self.diagnostics.lock().unwrap();
        let suspicious = diagnostics.iter().find(|line| {
            let line = line.to_ascii_lowercase();
            line.contains("database is locked")
                || line.contains("database disk image is malformed")
                || line.contains("database corruption")
                || line.contains("sqlite_busy")
                || line.contains("sqlite_corrupt")
        });
        if suspicious.is_some() {
            bail!("OpenCode emitted a database lock/corruption diagnostic");
        }
        Ok(())
    }

    async fn stop(&mut self) {
        terminate_process_group(&mut self.child);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
        if self.child.try_wait().ok().flatten().is_none() {
            kill_process_group(&mut self.child);
            let _ = self.child.wait().await;
        }
        if let Some(task) = self.stderr_task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for SpikeServe {
    fn drop(&mut self) {
        kill_process_group(&mut self.child);
    }
}

fn completed_tool_output(properties: &Value, session_id: &str) -> Option<String> {
    let part = properties.get("part")?;
    if part.get("sessionID").and_then(Value::as_str) != Some(session_id)
        || part.get("type").and_then(Value::as_str) != Some("tool")
        || part.pointer("/state/status").and_then(Value::as_str) != Some("completed")
    {
        return None;
    }
    part.pointer("/state/output")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn event_session_id(event: &Value) -> Option<String> {
    let properties = event.get("properties")?;
    properties
        .get("sessionID")
        .and_then(Value::as_str)
        .or_else(|| {
            properties
                .pointer("/part/sessionID")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            properties
                .pointer("/info/sessionID")
                .and_then(Value::as_str)
        })
        .or_else(|| properties.pointer("/info/id").and_then(Value::as_str))
        .map(str::to_owned)
}

fn reject_cross_session_event(event: &Value, expected_session_id: &str) -> Result<()> {
    if let Some(observed) = event_session_id(event) {
        if observed != expected_session_id {
            bail!("directory-scoped SSE delivered a different session id");
        }
    }
    Ok(())
}

#[cfg(unix)]
fn terminate_process_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
}

#[cfg(windows)]
fn terminate_process_group(child: &mut Child) {
    let _ = child.start_kill();
}

#[cfg(unix)]
fn kill_process_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}

#[cfg(windows)]
fn kill_process_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.start_kill();
}

fn opencode_version(binary: &str) -> Result<String> {
    let output = std::process::Command::new(binary)
        .arg("--version")
        .output()?;
    if !output.status.success() {
        bail!("OpenCode version command failed");
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_string())
}

fn platform() -> Result<String> {
    let output = std::process::Command::new("uname")
        .args(["-s", "-m"])
        .output()?;
    if !output.status.success() {
        bail!("uname failed");
    }
    Ok(String::from_utf8(output.stdout)?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("/"))
}

async fn measure_host_rss(binary: &str) -> Result<Vec<(usize, f64)>> {
    let mut hosts = Vec::new();
    let mut measurements = Vec::new();
    for count in 1..=6 {
        hosts.push(
            SpikeServe::spawn(binary, &format!("rss-host-{count}"))
                .await
                .with_context(|| format!("spawn RSS measurement host {count}"))?,
        );
        if [1, 2, 4, 6].contains(&count) {
            let total = hosts
                .iter()
                .map(SpikeServe::rss_mib)
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .sum();
            measurements.push((count, total));
        }
    }
    for host in &mut hosts {
        host.stop().await;
        host.assert_no_lock_or_corruption()?;
    }
    Ok(measurements)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a local opencode binary, provider credentials, and model"]
async fn concurrent_serves_share_state_without_locking_or_event_leakage() {
    let binary = std::env::var("TEAMCLU_OPENCODE_BIN").unwrap_or_else(|_| "opencode".to_string());
    let model = std::env::var("TEAMCLU_OPENCODE_SPIKE_MODEL")
        .expect("TEAMCLU_OPENCODE_SPIKE_MODEL=provider/model");

    let ws_a = tempfile::tempdir().unwrap();
    let ws_b = tempfile::tempdir().unwrap();
    let mut a = SpikeServe::spawn(&binary, "host-a").await.unwrap();
    let mut b = SpikeServe::spawn(&binary, "host-b").await.unwrap();

    let (session_a, session_b) =
        tokio::try_join!(a.create_session(ws_a.path()), b.create_session(ws_b.path()),).unwrap();

    let (tool_output_a, tool_output_b) = tokio::try_join!(
        a.prompt_for_sentinel(ws_a.path(), &session_a, &model),
        b.prompt_for_sentinel(ws_b.path(), &session_b, &model),
    )
    .unwrap();
    assert_eq!(tool_output_a.trim(), "host-a");
    assert_eq!(tool_output_b.trim(), "host-b");

    a.stop().await;
    a.assert_no_lock_or_corruption().unwrap();
    a = SpikeServe::spawn(&binary, "host-a").await.unwrap();
    assert!(a
        .resume_and_prompt(ws_a.path(), &session_a, &model)
        .await
        .is_ok());
    assert!(b.health().await);
    b.stop().await;

    a.assert_no_lock_or_corruption().unwrap();
    b.assert_no_lock_or_corruption().unwrap();
    a.stop().await;

    let rss = measure_host_rss(&binary).await.unwrap();
    println!(
        "VALIDATION_OPENCODE_VERSION={}",
        opencode_version(&binary).unwrap()
    );
    println!("VALIDATION_PLATFORM={}", platform().unwrap());
    println!(
        "VALIDATION_RSS_MIB={}",
        rss.iter()
            .map(|(hosts, mib)| format!("{hosts}={mib:.1}"))
            .collect::<Vec<_>>()
            .join(",")
    );
}

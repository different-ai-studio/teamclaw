use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, ListenerOptions, Name, ToFsName,
    ToNsName,
    traits::tokio::Listener as IpcListenerExt,
};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use log::{debug, info, warn, error, trace};

use serde::{Deserialize, Serialize};

use crate::error::Error;

/// Maximum accepted request-line length (10 MB). Connections sending longer
/// lines are dropped before any parsing or auth checking to bound memory use.
const MAX_LINE_BYTES: u64 = 10 * 1024 * 1024;
use crate::tools;
use crate::SocketType;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocketRequest {
    command: String,
    payload: Value,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    auth_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketResponse {
    pub success: bool,
    pub data: Option<Value>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

pub struct SocketServer<R: Runtime> {
    socket_type: SocketType,
    app: AppHandle<R>,
    running: Arc<AtomicBool>,
    shutdown_notify: Arc<tokio::sync::Notify>,
    listener_task: Option<tokio::task::JoinHandle<()>>,
    auth_token: Option<String>,
    token_file_path: Option<String>,
}

impl<R: Runtime> SocketServer<R> {
    pub fn new(app: AppHandle<R>, socket_type: SocketType, auth_token: Option<String>) -> Self {
        match &socket_type {
            SocketType::Ipc { path } => {
                let socket_path = if let Some(path) = path {
                    path.to_string_lossy().to_string()
                } else {
                    let temp_dir = std::env::temp_dir();
                    temp_dir
                        .join("tauri-mcp.sock")
                        .to_string_lossy()
                        .to_string()
                };
                info!(
                    "[TAURI_MCP] Initializing IPC socket server at: {}",
                    socket_path
                );
            }
            SocketType::Tcp { host, port } => {
                info!(
                    "[TAURI_MCP] Initializing TCP socket server at: {}:{}",
                    host, port
                );
            }
        }

        SocketServer {
            socket_type,
            app,
            running: Arc::new(AtomicBool::new(false)),
            shutdown_notify: Arc::new(tokio::sync::Notify::new()),
            listener_task: None,
            auth_token,
            token_file_path: None,
        }
    }

    pub fn start(&mut self) -> crate::Result<()> {
        info!("[TAURI_MCP] Starting socket server...");

        // Enter the tokio runtime context so create_tokio(), from_std(), and
        // tokio::spawn() work even though start() is called from the
        // synchronous plugin-setup path (main thread, outside an async block).
        let _rt_guard = tauri::async_runtime::handle().inner().enter();

        match &self.socket_type {
            SocketType::Ipc { path } => {
                self.start_ipc(path.clone())?;
            }
            SocketType::Tcp { host, port } => {
                self.start_tcp(host.clone(), *port)?;
            }
        }

        match &self.socket_type {
            SocketType::Ipc { path } => {
                let display_path = if let Some(p) = path {
                    p.to_string_lossy().to_string()
                } else {
                    std::env::temp_dir().join("tauri-mcp.sock").to_string_lossy().to_string()
                };
                info!(
                    "[TAURI_MCP] Socket server started successfully at {}",
                    display_path
                );
            }
            SocketType::Tcp { host, port } => {
                info!(
                    "[TAURI_MCP] Socket server started successfully at {}:{}",
                    host, port
                );
            }
        }
        Ok(())
    }

    fn start_ipc(&mut self, path: Option<std::path::PathBuf>) -> crate::Result<()> {
        let socket_name = self.get_socket_name(&path)?;

        // Stale socket cleanup: try connecting to see if another instance is running
        #[cfg(unix)]
        {
            let socket_path = if let Some(p) = &path {
                p.to_string_lossy().to_string()
            } else {
                std::env::temp_dir().join("tauri-mcp.sock").to_string_lossy().to_string()
            };
            if let Ok(metadata) = std::fs::symlink_metadata(&socket_path) {
                use std::os::unix::fs::FileTypeExt;
                if !metadata.file_type().is_socket() {
                    return Err(Error::Io(format!(
                        "Path {} exists but is not a Unix socket — refusing to remove",
                        socket_path
                    )));
                }
                match std::os::unix::net::UnixStream::connect(&socket_path) {
                    Ok(_) => {
                        return Err(Error::Io(format!(
                            "Socket {} is in use by another instance",
                            socket_path
                        )));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                        info!("[TAURI_MCP] Removing stale socket file: {}", socket_path);
                        let _ = std::fs::remove_file(&socket_path);
                    }
                    Err(e) => {
                        return Err(Error::Io(format!(
                            "Cannot connect to socket {} and cannot determine if it is stale: {}",
                            socket_path, e
                        )));
                    }
                }
            }
        }

        // Create tokio IPC listener
        let opts = ListenerOptions::new().name(socket_name);
        let ipc_listener = opts.create_tokio()
            .map_err(|e| {
                info!("[TAURI_MCP] Error creating IPC socket listener: {}", e);
                if e.kind() == std::io::ErrorKind::AddrInUse {
                    Error::Io(format!("Socket address already in use. Another instance may be running."))
                } else {
                    Error::Io(format!("Failed to create local socket: {}", e))
                }
            })?;

        // Restrict the socket file to the owning user (0o600) so other local
        // users cannot connect to an unauthenticated server.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let socket_path = if let Some(p) = &path {
                p.to_string_lossy().to_string()
            } else {
                std::env::temp_dir().join("tauri-mcp.sock").to_string_lossy().to_string()
            };
            match std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)) {
                Ok(_) => info!("[TAURI_MCP] Set socket file permissions to 0600: {}", socket_path),
                Err(e) => warn!(
                    "[TAURI_MCP] Failed to set socket file permissions on {}: {}",
                    socket_path, e
                ),
            }
        }

        self.write_auth_token_file()?;
        self.running.store(true, Ordering::Release);
        info!("[TAURI_MCP] Set running flag to true");

        let app = self.app.clone();
        let running = self.running.clone();
        let shutdown = self.shutdown_notify.clone();
        let auth_token: Option<Arc<str>> = self.auth_token.as_deref().map(Into::into);

        info!("[TAURI_MCP] Spawning IPC listener task");
        self.listener_task = Some(tokio::spawn(async move {
            info!("[TAURI_MCP] Listener task started for IPC socket");
            // Connection handlers live in this JoinSet so they are aborted
            // (via shutdown() or the set's Drop when this task is aborted)
            // instead of outliving stop() with a live AppHandle.
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown.notified() => {
                        info!("[TAURI_MCP] Shutdown signal received, stopping IPC listener");
                        break;
                    }
                    result = ipc_listener.accept() => {
                        if !running.load(Ordering::Acquire) {
                            break;
                        }
                        match result {
                            Ok(stream) => {
                                info!("[TAURI_MCP] Accepted new IPC connection");
                                let app_clone = app.clone();
                                let auth_token_clone = auth_token.clone();
                                connections.spawn(async move {
                                    let (reader, writer) = tokio::io::split(stream);
                                    if let Err(e) = handle_client_async(reader, writer, app_clone, auth_token_clone).await {
                                        if is_disconnect_crate_error(&e) {
                                            info!("[TAURI_MCP] Client disconnected normally");
                                        } else {
                                            error!("[TAURI_MCP] Error handling IPC client: {}", e);
                                        }
                                    }
                                });
                                // Reap any handlers that have already finished.
                                while connections.try_join_next().is_some() {}
                            }
                            Err(e) => {
                                if running.load(Ordering::Acquire) {
                                    error!("[TAURI_MCP] Error accepting IPC connection: {}", e);
                                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                }
                            }
                        }
                    }
                }
            }
            connections.shutdown().await;
            info!("[TAURI_MCP] IPC listener task ending");
        }));

        Ok(())
    }

    fn start_tcp(&mut self, host: String, port: u16) -> crate::Result<()> {
        // TCP host validation: reject non-loopback without auth token
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            if !ip.is_loopback() {
                if self.auth_token.is_none() {
                    return Err(Error::Io(format!(
                        "Binding to non-loopback address {} without an auth token is not allowed. \
                         Set an auth token or use a loopback address (127.0.0.1 / ::1).",
                        host
                    )));
                }
                warn!(
                    "[TAURI_MCP] WARNING: Binding to non-loopback address {}:{}. \
                     Ensure auth token is configured and network is trusted.",
                    host, port
                );
            }
        } else {
            warn!("[TAURI_MCP] Could not parse host '{}' as IP address", host);
        }

        // Bind synchronously, then convert to tokio
        let addr = format!("{}:{}", host, port);
        let std_listener = std::net::TcpListener::bind(&addr)
            .map_err(|e| {
                info!("[TAURI_MCP] Error creating TCP socket listener: {}", e);
                Error::Io(format!("Failed to bind to {}: {}", addr, e))
            })?;
        std_listener.set_nonblocking(true)
            .map_err(|e| Error::Io(format!("Failed to set non-blocking: {}", e)))?;
        let tcp_listener = tokio::net::TcpListener::from_std(std_listener)
            .map_err(|e| Error::Io(format!("Failed to create tokio TcpListener: {}", e)))?;

        self.write_auth_token_file()?;
        self.running.store(true, Ordering::Release);
        info!("[TAURI_MCP] Set running flag to true");

        let app = self.app.clone();
        let running = self.running.clone();
        let shutdown = self.shutdown_notify.clone();
        let auth_token: Option<Arc<str>> = self.auth_token.as_deref().map(Into::into);

        info!("[TAURI_MCP] Spawning TCP listener task");
        self.listener_task = Some(tokio::spawn(async move {
            info!("[TAURI_MCP] Listener task started for TCP socket at {}", addr);
            // See the IPC listener: connection handlers must not outlive stop().
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown.notified() => {
                        info!("[TAURI_MCP] Shutdown signal received, stopping TCP listener");
                        break;
                    }
                    result = tcp_listener.accept() => {
                        if !running.load(Ordering::Acquire) {
                            break;
                        }
                        match result {
                            Ok((stream, addr)) => {
                                info!("[TAURI_MCP] Accepted new TCP connection from: {}", addr);
                                let app_clone = app.clone();
                                let auth_token_clone = auth_token.clone();
                                connections.spawn(async move {
                                    let (reader, writer) = tokio::io::split(stream);
                                    if let Err(e) = handle_client_async(reader, writer, app_clone, auth_token_clone).await {
                                        error!("[TAURI_MCP] Error handling TCP client: {}", e);
                                    }
                                });
                                while connections.try_join_next().is_some() {}
                            }
                            Err(e) => {
                                if running.load(Ordering::Acquire) {
                                    error!("[TAURI_MCP] Error accepting TCP connection: {}", e);
                                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                }
                            }
                        }
                    }
                }
            }
            connections.shutdown().await;
            info!("[TAURI_MCP] TCP listener task ending");
        }));

        Ok(())
    }

    /// Compute the on-disk token file path for the configured socket.
    fn token_file_path_for_socket(&self) -> String {
        match &self.socket_type {
            SocketType::Ipc { path } => {
                let socket_path = path.clone().unwrap_or_else(|| {
                    std::env::temp_dir().join("tauri-mcp.sock")
                });
                format!("{}.token", socket_path.display())
            }
            SocketType::Tcp { port, .. } => {
                format!("{}/tauri-mcp-{}.token", std::env::temp_dir().display(), port)
            }
        }
    }

    fn write_auth_token_file(&mut self) -> crate::Result<()> {
        let token_path = self.token_file_path_for_socket();

        if let Some(ref token) = self.auth_token {
            // Write with restrictive permissions on Unix (owner-only read/write)
            let write_result = {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(0o600)
                        .open(&token_path)
                        .and_then(|mut f| {
                            use std::io::Write;
                            f.write_all(token.as_bytes())
                        })
                }
                #[cfg(not(unix))]
                {
                    std::fs::write(&token_path, token)
                }
            };

            match write_result {
                Ok(_) => {
                    info!("[TAURI_MCP] Auth token written to {}", token_path);
                    self.token_file_path = Some(token_path);
                }
                Err(e) => {
                    error!("[TAURI_MCP] Failed to write auth token file {}: {}", token_path, e);
                }
            }
        } else {
            // No token configured this run: remove any leftover token file
            // from a crashed prior run so clients don't pick up a stale token.
            match std::fs::remove_file(&token_path) {
                Ok(_) => info!(
                    "[TAURI_MCP] Removed stale auth token file from previous run: {}",
                    token_path
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Nothing to clean up.
                }
                Err(e) => warn!(
                    "[TAURI_MCP] Failed to remove stale auth token file {}: {}",
                    token_path, e
                ),
            }
        }
        Ok(())
    }

    pub fn stop(&mut self) -> crate::Result<()> {
        info!("[TAURI_MCP] Stopping socket server");
        self.running.store(false, Ordering::Release);
        self.shutdown_notify.notify_waiters();

        // Abort listener task as safety net
        if let Some(handle) = self.listener_task.take() {
            handle.abort();
        }

        // Delete the auth token file if we created one
        if let Some(ref path) = self.token_file_path {
            match std::fs::remove_file(path) {
                Ok(_) => info!("[TAURI_MCP] Deleted auth token file: {}", path),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Already gone — not an error
                }
                Err(e) => {
                    error!("[TAURI_MCP] Failed to delete auth token file {}: {}", path, e);
                }
            }
        }

        info!("[TAURI_MCP] Socket server stopped");
        Ok(())
    }

    #[cfg(desktop)]
    fn get_socket_name(&self, path: &Option<std::path::PathBuf>) -> Result<Name<'_>, Error> {
        let socket_path = if let Some(p) = path {
            p.to_string_lossy().to_string()
        } else {
            let temp_dir = std::env::temp_dir();
            temp_dir.join("tauri-mcp.sock").to_string_lossy().to_string()
        };

        if cfg!(target_os = "windows") {
            // Use named pipe on Windows
            socket_path
                .to_ns_name::<GenericNamespaced>()
                .map_err(|e| Error::Io(format!("Failed to create pipe name: {}", e)))
        } else {
            // Use file-based socket on Unix platforms
            socket_path
                .clone()
                .to_fs_name::<GenericFilePath>()
                .map_err(|e| Error::Io(format!("Failed to create file socket name: {}", e)))
        }
    }
}

/// Constant-time byte comparison to prevent timing side-channels on auth tokens.
fn ct_eq(provided: &[u8], expected: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    if provided.len() != expected.len() {
        // subtle's ct_eq short-circuits on unequal lengths; burn the same
        // time as a full comparison so duration doesn't reveal the expected
        // token's length.
        let _ = expected.ct_eq(expected);
        return false;
    }
    provided.ct_eq(expected).into()
}

/// Helper to check if an IO error indicates client disconnection
fn is_disconnect_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::UnexpectedEof
    )
}

/// Check whether a crate-level error wraps an IO disconnect.
fn is_disconnect_crate_error(e: &Error) -> bool {
    matches!(e, Error::IoSource(io_err) if is_disconnect_error(io_err))
}

async fn handle_client_async<R, Reader, Writer>(
    reader: Reader,
    mut writer: Writer,
    app: AppHandle<R>,
    auth_token: Option<Arc<str>>,
) -> crate::Result<()>
where
    R: Runtime,
    Reader: tokio::io::AsyncRead + Unpin,
    Writer: tokio::io::AsyncWrite + Unpin,
{
    info!("[TAURI_MCP] Handling new client connection");

    // A `mouse_down`-only request (the start of a drag) leaves an OS-level
    // mouse button held until the paired `mouse_up` arrives. If this client
    // vanishes mid-drag — clean disconnect, pipe error, or task abort on
    // server shutdown — that button would stay physically pressed and wedge
    // the user's real cursor. This guard force-releases any still-held button
    // on every exit path of the connection.
    struct ButtonReleaseGuard;
    impl Drop for ButtonReleaseGuard {
        fn drop(&mut self) {
            crate::native_input::release_held_buttons();
        }
    }
    let _button_guard = ButtonReleaseGuard;

    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        // Cap the accepted line length so an unauthenticated client can't
        // exhaust memory by streaming an endless line (pre-auth DoS). We read
        // through a `take` limit of MAX+1: if more than MAX bytes arrive
        // without a newline, drop the connection before parsing.
        let mut limited = (&mut reader).take(MAX_LINE_BYTES + 1);
        match limited.read_line(&mut line).await {
            Ok(0) => {
                info!("[TAURI_MCP] Client disconnected cleanly");
                return Ok(());
            }
            Ok(n) => {
                if n as u64 > MAX_LINE_BYTES {
                    warn!(
                        "[TAURI_MCP] Request line exceeded {} bytes; dropping connection",
                        MAX_LINE_BYTES
                    );
                    return Ok(());
                }
                // Raw request lines carry the auth token — never log them
                // above trace, and redact the token even there.
                if log::log_enabled!(log::Level::Trace) {
                    trace!("[TAURI_MCP] Read: {}", redact_auth_token(line.trim()));
                }
            }
            Err(e) => {
                if is_disconnect_error(&e) {
                    info!("[TAURI_MCP] Client disconnected during read (pipe error)");
                    return Ok(());
                }
                return Err(Error::IoSource(e));
            }
        }

        // Parse and process the request
        let request: SocketRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                let error_msg = format!("Invalid request format: {}", e);
                info!("[TAURI_MCP] {}", error_msg);

                let error_response = SocketResponse {
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    id: None,
                };

                let error_json = match serde_json::to_string(&error_response) {
                    Ok(json) => json + "\n",
                    Err(_) => {
                        return Err(Error::Anyhow(
                            "Failed to serialize error response".to_string(),
                        ));
                    }
                };

                if let Err(e) = write_response(&mut writer, error_json.as_bytes()).await {
                    return Err(e);
                }
                continue;
            }
        };

        // Validate auth token if configured (constant-time comparison)
        if let Some(ref expected_token) = auth_token {
            match &request.auth_token {
                Some(provided_token) if ct_eq(provided_token.as_bytes(), expected_token.as_bytes()) => {
                    // Token matches, proceed
                }
                _ => {
                    let request_id = request.id.clone();
                    let error_response = SocketResponse {
                        success: false,
                        data: None,
                        error: Some("Authentication failed: invalid or missing auth token".to_string()),
                        id: request_id,
                    };
                    let error_json = serde_json::to_string(&error_response)
                        .map_err(|e| Error::Anyhow(format!("Failed to serialize auth error: {}", e)))?
                        + "\n";
                    if let Err(e) = write_response(&mut writer, error_json.as_bytes()).await {
                        return Err(e);
                    }
                    continue;
                }
            }
        }

        debug!("[TAURI_MCP] Processing command: {}", request.command);

        let request_id = request.id.clone();

        let mut response = match tools::handle_command(&app, &request.command, request.payload).await {
            Ok(resp) => resp,
            Err(e) => {
                info!("[TAURI_MCP] Command error: {}", e);
                SocketResponse {
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                    id: None,
                }
            }
        };

        response.id = request_id;

        let response_json = serde_json::to_string(&response)
            .map_err(|e| Error::Anyhow(format!("Failed to serialize response: {}", e)))?
            + "\n";
        debug!(
            "[TAURI_MCP] Sending response: length = {} bytes",
            response_json.len()
        );
        if log::log_enabled!(log::Level::Trace) {
            trace!("[TAURI_MCP] Writing: {}", response_json.trim());
        }

        if let Err(e) = write_response(&mut writer, response_json.as_bytes()).await {
            return Err(e);
        }

        debug!("[TAURI_MCP] Response sent successfully");
    }
}

/// Redact the authToken value in a raw request line before logging it.
fn redact_auth_token(line: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                if obj.contains_key("authToken") {
                    obj.insert("authToken".into(), serde_json::Value::String("<redacted>".into()));
                }
            }
            v.to_string()
        }
        // Unparseable line — don't risk echoing a token fragment.
        Err(_) => "<unparseable request line redacted>".to_string(),
    }
}

/// Write bytes to the async writer, handling disconnect errors gracefully.
async fn write_response<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    data: &[u8],
) -> crate::Result<()> {
    match writer.write_all(data).await {
        Ok(_) => {}
        Err(e) if is_disconnect_error(&e) => {
            info!("[TAURI_MCP] Client disconnected during write (pipe error)");
            return Ok(());
        }
        Err(e) => return Err(Error::IoSource(e)),
    }
    match writer.flush().await {
        Ok(_) => Ok(()),
        Err(e) if is_disconnect_error(&e) => {
            info!("[TAURI_MCP] Client disconnected during flush (pipe error)");
            Ok(())
        }
        Err(e) => Err(Error::IoSource(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_socket_request_deserialization() {
        let json = r#"{"command":"ping","payload":{"value":"hello"}}"#;
        let req: SocketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "ping");
        assert!(req.id.is_none());
        assert!(req.auth_token.is_none());
    }

    #[test]
    fn test_socket_request_with_id_and_auth() {
        let json = r#"{"command":"get_dom","payload":{},"id":"req-123","authToken":"secret"}"#;
        let req: SocketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "get_dom");
        assert_eq!(req.id.as_deref(), Some("req-123"));
        assert_eq!(req.auth_token.as_deref(), Some("secret"));
    }

    #[test]
    fn test_socket_response_serialization_success() {
        let resp = SocketResponse {
            success: true,
            data: Some(serde_json::json!({"key": "value"})),
            error: None,
            id: Some("req-1".to_string()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"id\":\"req-1\""));
        assert!(json.contains("\"error\":null"));
    }

    #[test]
    fn test_socket_response_serialization_error() {
        let resp = SocketResponse {
            success: false,
            data: None,
            error: Some("something failed".to_string()),
            id: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"success\":false"));
        assert!(json.contains("something failed"));
    }

    #[test]
    fn test_auth_token_matching() {
        let expected: Arc<str> = Arc::from("my-secret-token");
        let provided = "my-secret-token";
        assert!(ct_eq(provided.as_bytes(), expected.as_bytes()));

        let wrong = "wrong-token";
        assert!(!ct_eq(wrong.as_bytes(), expected.as_bytes()));
    }
}

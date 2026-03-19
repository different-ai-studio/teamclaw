use interprocess::TryClone;
use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, Listener as IpcListener, ListenerOptions, Name, Stream as IpcStream, ToFsName,
    ToNsName, prelude::*,
};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Runtime};
use log::{info, error};

use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::tools;
use crate::SocketType;

/// A wrapper stream that logs all reads and writes for debugging
struct LoggingStream<S: Write + Read> {
    inner: S,
}

impl<S: Write + Read> LoggingStream<S> {
    fn new(inner: S) -> Self {
        Self { inner }
    }
}

impl<S: Write + Read> Write for LoggingStream<S> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        info!("[TAURI_MCP] Writing: {}", String::from_utf8_lossy(buf));
        self.inner.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl<S: Write + Read> Read for LoggingStream<S> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        info!(
            "[TAURI_MCP] Read: {}",
            String::from_utf8_lossy(&buf[..n])
        );
        Ok(n)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocketRequest {
    command: String,
    payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketResponse {
    pub success: bool,
    pub data: Option<Value>,
    pub error: Option<String>,
}

/// Unified stream type that can handle both IPC and TCP
enum UnifiedStream {
    Ipc(IpcStream),
    Tcp(TcpStream),
}

impl Read for UnifiedStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            UnifiedStream::Ipc(stream) => stream.read(buf),
            UnifiedStream::Tcp(stream) => stream.read(buf),
        }
    }
}

impl Write for UnifiedStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            UnifiedStream::Ipc(stream) => stream.write(buf),
            UnifiedStream::Tcp(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            UnifiedStream::Ipc(stream) => stream.flush(),
            UnifiedStream::Tcp(stream) => stream.flush(),
        }
    }
}

impl UnifiedStream {
    fn try_clone(&self) -> std::io::Result<Self> {
        match self {
            UnifiedStream::Ipc(stream) => Ok(UnifiedStream::Ipc(stream.try_clone()?)),
            UnifiedStream::Tcp(stream) => Ok(UnifiedStream::Tcp(stream.try_clone()?)),
        }
    }
}

/// Unified listener type that can handle both IPC and TCP
enum UnifiedListener {
    Ipc(IpcListener),
    Tcp(TcpListener),
}

pub struct SocketServer<R: Runtime> {
    listener: Option<Arc<Mutex<UnifiedListener>>>,
    socket_type: SocketType,
    app: AppHandle<R>,
    running: Arc<Mutex<bool>>,
}

impl<R: Runtime> SocketServer<R> {
    pub fn new(app: AppHandle<R>, socket_type: SocketType) -> Self {
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
            listener: None,
            socket_type,
            app,
            running: Arc::new(Mutex::new(false)),
        }
    }

    pub fn start(&mut self) -> crate::Result<()> {
        info!("[TAURI_MCP] Starting socket server...");

        let listener = match &self.socket_type {
            SocketType::Ipc { path } => {
                // Get the socket path for cleanup
                let socket_path = if let Some(p) = path {
                    p.clone()
                } else {
                    std::env::temp_dir().join("tauri-mcp.sock")
                };

                // Clean up any stale socket file on Unix platforms
                #[cfg(not(target_os = "windows"))]
                if socket_path.exists() {
                    info!("[TAURI_MCP] Removing stale socket file: {:?}", socket_path);
                    std::fs::remove_file(&socket_path)
                        .map_err(|e| Error::Io { message: format!("Failed to remove stale socket: {}", e) })?;
                }

                // Create a name for our socket based on the platform
                let socket_name = self.get_socket_name(path)?;

                // Configure and create the IPC listener
                let opts = ListenerOptions::new().name(socket_name);
                let ipc_listener = opts.create_sync()
                    .map_err(|e| {
                        info!("[TAURI_MCP] Error creating IPC socket listener: {}", e);
                        if e.kind() == std::io::ErrorKind::AddrInUse {
                            Error::Io { message: format!("Socket address already in use. If the socket file exists, it may be a stale socket. Try removing it manually.") }
                        } else {
                            Error::Io { message: format!("Failed to create local socket: {}", e) }
                        }
                    })?;
                UnifiedListener::Ipc(ipc_listener)
            }
            SocketType::Tcp { host, port } => {
                // Create TCP listener
                let addr = format!("{}:{}", host, port);
                let tcp_listener = TcpListener::bind(&addr)
                    .map_err(|e| {
                        info!("[TAURI_MCP] Error creating TCP socket listener: {}", e);
                        Error::Io { message: format!("Failed to bind to {}: {}", addr, e) }
                    })?;
                UnifiedListener::Tcp(tcp_listener)
            }
        };

        let listener = Arc::new(Mutex::new(listener));
        self.listener = Some(listener.clone());

        *self.running.lock().unwrap() = true;
        info!("[TAURI_MCP] Set running flag to true");

        let app = self.app.clone();
        let running = self.running.clone();
        let socket_type = self.socket_type.clone();

        // Spawn a thread to handle socket connections
        info!("[TAURI_MCP] Spawning listener thread");
        thread::spawn(move || {
            match &socket_type {
                SocketType::Ipc { .. } => {
                    info!("[TAURI_MCP] Listener thread started for IPC socket");
                }
                SocketType::Tcp { host, port } => {
                    info!("[TAURI_MCP] Listener thread started for TCP socket at {}:{}", host, port);
                }
            }

            // Set panic handler to suppress specific Windows named pipe errors
            let original_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |panic_info| {
                let panic_payload = panic_info.payload();
                let is_pipe_error = if let Some(s) = panic_payload.downcast_ref::<String>() {
                    s.contains("No process is on the other end of the pipe")
                } else if let Some(s) = panic_payload.downcast_ref::<&str>() {
                    s.contains("No process is on the other end of the pipe")
                } else {
                    false
                };

                // If it's not the Windows pipe disconnection error, pass to the original handler
                if !is_pipe_error {
                    original_hook(panic_info);
                } else {
                    // Just log the error instead of panicking
                    info!(
                        "[TAURI_MCP] Handled pipe disconnection (normal client disconnect)"
                    );
                }
            }));

            let listener_guard = listener.lock().unwrap();

            loop {
                if !*running.lock().unwrap() {
                    break;
                }

                match &*listener_guard {
                    UnifiedListener::Ipc(ipc_listener) => {
                        // Handle IPC connections
                        for conn in ipc_listener.incoming() {
                            if !*running.lock().unwrap() {
                                break;
                            }

                            match conn {
                                Ok(stream) => {
                                    info!("[TAURI_MCP] Accepted new IPC connection");
                                    let app_clone = app.clone();
                                    let unified_stream = UnifiedStream::Ipc(stream);

                                    // Spawn a new thread with its own panic handler for client handling
                                    thread::spawn(move || {
                                        // Set a similar panic handler for the client handler thread
                                        let client_hook = std::panic::take_hook();
                                        std::panic::set_hook(Box::new(move |panic_info| {
                                            let panic_payload = panic_info.payload();
                                            let is_pipe_error = if let Some(s) =
                                                panic_payload.downcast_ref::<String>()
                                            {
                                                s.contains("No process is on the other end of the pipe")
                                            } else if let Some(s) = panic_payload.downcast_ref::<&str>() {
                                                s.contains("No process is on the other end of the pipe")
                                            } else {
                                                false
                                            };

                                            if !is_pipe_error {
                                                client_hook(panic_info);
                                            } else {
                                                info!(
                                                    "[TAURI_MCP] Handled pipe disconnection in client thread"
                                                );
                                            }
                                        }));

                                        // Handle the client with error trapping
                                        if let Err(e) = handle_client(unified_stream, app_clone) {
                                            if e.to_string()
                                                .contains("No process is on the other end of the pipe")
                                            {
                                                info!("[TAURI_MCP] Client disconnected normally");
                                            } else {
                                                error!("[TAURI_MCP] Error handling client: {}", e);
                                            }
                                        }
                                    });
                                }
                                Err(e) => {
                                    error!("[TAURI_MCP] Error accepting IPC connection: {}", e);
                                    // Short sleep to avoid busy waiting in case of persistent errors
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                }
                            }

                            // Check the running flag after each connection
                            if !*running.lock().unwrap() {
                                break;
                            }
                        }
                    }
                    UnifiedListener::Tcp(tcp_listener) => {
                        // Handle TCP connections
                        // Set non-blocking mode to allow checking the running flag
                        tcp_listener.set_nonblocking(true).ok();
                        
                        loop {
                            if !*running.lock().unwrap() {
                                break;
                            }

                            match tcp_listener.accept() {
                                Ok((stream, addr)) => {
                                    info!("[TAURI_MCP] Accepted new TCP connection from: {}", addr);
                                    
                                    // Set the stream back to blocking mode for normal I/O operations
                                    if let Err(e) = stream.set_nonblocking(false) {
                                        error!("[TAURI_MCP] Failed to set stream to blocking mode: {}", e);
                                        continue;
                                    }
                                    
                                    let app_clone = app.clone();
                                    let unified_stream = UnifiedStream::Tcp(stream);

                                    // Spawn a new thread for client handling
                                    thread::spawn(move || {
                                        // Handle the client with error trapping
                                        if let Err(e) = handle_client(unified_stream, app_clone) {
                                            error!("[TAURI_MCP] Error handling TCP client: {}", e);
                                        }
                                    });
                                }
                                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                    // No connection available, sleep briefly
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                }
                                Err(e) => {
                                    error!("[TAURI_MCP] Error accepting TCP connection: {}", e);
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                }
                            }
                        }
                    }
                }
            }
            info!("[TAURI_MCP] Listener thread ending");
        });

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

    pub fn stop(&self) -> crate::Result<()> {
        info!("[TAURI_MCP] Stopping socket server");
        // Set running flag to false to stop the server thread
        *self.running.lock().unwrap() = false;

        // The interprocess crate automatically cleans up the socket file on drop for Unix platforms
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
                .map_err(|e| Error::Io { message: format!("Failed to create pipe name: {}", e) })
        } else {
            // Use file-based socket on Unix platforms
            socket_path
                .clone()
                .to_fs_name::<GenericFilePath>()
                .map_err(|e| Error::Io { message: format!("Failed to create file socket name: {}", e) })
        }
    }
}

fn handle_client<R: Runtime>(stream: UnifiedStream, app: AppHandle<R>) -> crate::Result<()> {
    info!("[TAURI_MCP] Handling new client connection");
    // Create a new runtime for this thread since handle_client runs in a separate thread
    // spawned by the socket listener, not in Tauri's async context
    let rt = tokio::runtime::Runtime::new()
        .map_err(|e| Error::Io { message: format!("Failed to create runtime: {}", e) })?;

    rt.block_on(async {
        // Create a buffered reader and separate writer for the socket
        let stream_clone = match stream.try_clone() {
            Ok(clone) => clone,
            Err(e) => {
                // This might be a disconnection error on Windows
                if e.to_string()
                    .contains("No process is on the other end of the pipe")
                {
                    info!("[TAURI_MCP] Client already disconnected (pipe error)");
                    return Ok(());
                }
                return Err(Error::Io { message: format!("Failed to clone stream: {}", e) });
            }
        };

        // Wrap the streams with our logging wrapper
        let logging_reader = LoggingStream::new(stream_clone);
        let mut reader = BufReader::new(logging_reader);
        let mut writer = LoggingStream::new(stream);

        // Keep handling requests until the client disconnects
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    // End of stream, client disconnected
                    info!("[TAURI_MCP] Client disconnected cleanly");
                    return Ok(());
                }
                Ok(_) => {
                    info!("[TAURI_MCP] Received command: {}", line.trim());
                }
                Err(e) => {
                    // Check if this is a pipe disconnection error
                    if e.to_string()
                        .contains("No process is on the other end of the pipe")
                        || e.kind() == std::io::ErrorKind::BrokenPipe
                    {
                        info!("[TAURI_MCP] Client disconnected during read (pipe error)");
                        return Ok(());
                    }
                    return Err(Error::Io { message: format!("Error reading from socket: {}", e) });
                }
            };

        // Parse and process the request
        let request: SocketRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                let error_msg = format!("Invalid request format: {}", e);
                info!("[TAURI_MCP] {}", error_msg);

                // Create and send an error response
                let error_response = SocketResponse {
                    success: false,
                    data: None,
                    error: Some(error_msg),
                };

                let error_json = match serde_json::to_string(&error_response) {
                    Ok(json) => json + "\n",
                    Err(e) => {
                        return Err(Error::serialization_error(
                            format!("Failed to serialize error response: {}", e),
                        ));
                    }
                };

                match writer.write_all(error_json.as_bytes()) {
                    Ok(_) => {
                        if let Err(e) = writer.flush() {
                            return Err(Error::Io { message: format!("Error flushing error response: {}", e) });
                        }
                    }
                    Err(e) => {
                        return Err(Error::Io { message: format!("Error writing error response: {}", e) });
                    }
                }

                // Clear the line and continue to the next iteration
                line.clear();
                continue;
            }
        };

        info!("[TAURI_MCP] Processing command: {}", request.command);

        // Use the centralized command handler from tools module
        let response = match tools::handle_command(&app, &request.command, request.payload).await {
            Ok(resp) => resp,
            Err(e) => {
                // Convert the error into a response structure
                info!("[TAURI_MCP] Command error: {}", e);
                SocketResponse {
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                }
            }
        };

        // When writing the response, handle pipe errors gracefully
        let response_json = serde_json::to_string(&response)
            .map_err(|e| Error::serialization_error(format!("Failed to serialize response: {}", e)))?
            + "\n";
        info!(
            "[TAURI_MCP] Sending response: length = {} bytes",
            response_json.len()
        );

        // Write the response directly without chunking
        match writer.write_all(response_json.as_bytes()) {
            Ok(_) => {
                match writer.flush() {
                    Ok(_) => {
                        info!("[TAURI_MCP] Response sent successfully");
                        // Continue to the next iteration of the loop
                    }
                    Err(e) => {
                        if e.to_string()
                            .contains("No process is on the other end of the pipe")
                            || e.kind() == std::io::ErrorKind::BrokenPipe
                        {
                            info!(
                                "[TAURI_MCP] Client disconnected during flush (pipe error)"
                            );
                            return Ok(()); // Return success for expected client disconnect
                        } else {
                            return Err(Error::Io { message: format!("Error flushing response: {}", e) });
                        }
                    }
                }
            }
            Err(e) => {
                if e.to_string()
                    .contains("No process is on the other end of the pipe")
                    || e.kind() == std::io::ErrorKind::BrokenPipe
                {
                    info!("[TAURI_MCP] Client disconnected during write (pipe error)");
                    return Ok(()); // Return success for expected client disconnect
                } else {
                    return Err(Error::Io { message: format!("Error writing response: {}", e) });
                }
            }
        }
        
        // Clear the line for the next command
        line.clear();
        } // End of loop
    })
}

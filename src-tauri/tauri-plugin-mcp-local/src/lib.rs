use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};
use log::info;

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;
pub mod shared;
mod socket_server;
mod tools;
// Platform-specific module
mod platform;

pub use error::{Error, Result};
pub use shared::{
    McpInterface, ScreenshotParams, ScreenshotResult, WindowManagerParams, WindowManagerResult,
};

#[cfg(desktop)]
use desktop::TauriMcp;
#[cfg(mobile)]
use mobile::TauriMcp;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the tauri-mcp APIs.
pub trait TauriMcpExt<R: Runtime> {
    fn tauri_mcp(&self) -> &TauriMcp<R>;
}

impl<R: Runtime, T: Manager<R>> crate::TauriMcpExt<R> for T {
    fn tauri_mcp(&self) -> &TauriMcp<R> {
        self.state::<TauriMcp<R>>().inner()
    }
}

/// Socket connection type
#[derive(Clone, Debug)]
pub enum SocketType {
    /// Use IPC (Unix domain socket or Windows named pipe)
    Ipc {
        /// Path to the socket file. If None, a default path will be used.
        path: Option<std::path::PathBuf>,
    },
    /// Use TCP socket
    Tcp {
        /// Host to bind to (e.g., "127.0.0.1" or "0.0.0.0")
        host: String,
        /// Port to bind to
        port: u16,
    },
}

impl Default for SocketType {
    fn default() -> Self {
        SocketType::Ipc { path: None }
    }
}

/// Plugin configuration options.
#[derive(Default)]
pub struct PluginConfig {
    /// Application name (used for default socket naming)
    pub application_name: String,
    /// Socket configuration
    pub socket_type: SocketType,
    /// Whether to start the socket server automatically. Default is true.
    pub start_socket_server: bool,
}

impl PluginConfig {
    /// Create a new plugin configuration with default values.
    pub fn new(application_name: String) -> Self {
        Self {
            application_name,
            socket_type: SocketType::default(),
            start_socket_server: true,
        }
    }

    /// Set the socket path for IPC mode.
    pub fn socket_path(mut self, path: std::path::PathBuf) -> Self {
        self.socket_type = SocketType::Ipc { path: Some(path) };
        self
    }

    /// Configure TCP socket mode.
    pub fn tcp(mut self, host: String, port: u16) -> Self {
        self.socket_type = SocketType::Tcp { host, port };
        self
    }

    /// Set whether to start the socket server automatically.
    pub fn start_socket_server(mut self, start: bool) -> Self {
        self.start_socket_server = start;
        self
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    init_with_config(PluginConfig::default())
}

/// Initializes the plugin with the given configuration.
pub fn init_with_config<R: Runtime>(config: PluginConfig) -> TauriPlugin<R> {
    // Log socket configuration
    match &config.socket_type {
        SocketType::Ipc { path } => {
            if let Some(path) = path {
                info!(
                    "[TAURI_MCP] Socket server will use custom IPC path: {}",
                    path.display()
                );
            } else {
                let default_path = std::env::temp_dir().join("tauri-mcp.sock");
                info!(
                    "[TAURI_MCP] Socket server will use default IPC path: {}",
                    default_path.display()
                );
            }
        }
        SocketType::Tcp { host, port } => {
            info!(
                "[TAURI_MCP] Socket server will use TCP: {}:{}",
                host, port
            );
        }
    }

    if config.start_socket_server {
        info!("[TAURI_MCP] Socket server will start automatically");
    } else {
        info!("[TAURI_MCP] Socket server auto-start is disabled");
    }

    Builder::new("tauri-mcp")
        .invoke_handler(tauri::generate_handler![
        // Server Commands
        ])
        .setup(move |app, api| {
            info!("[TAURI_MCP] Setting up plugin");
            #[cfg(mobile)]
            panic!("Mobile is not supported");
            #[cfg(desktop)]
            let tauri_mcp = desktop::init(app, api, &config)?;
            app.manage(tauri_mcp);
            info!("[TAURI_MCP] Plugin setup complete");
            Ok(())
        })
        .build()
}

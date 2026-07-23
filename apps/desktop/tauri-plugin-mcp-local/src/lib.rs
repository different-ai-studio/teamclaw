use log::{error, info, warn};
use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

pub use models::*;

#[cfg(desktop)]
mod desktop;

mod error;
pub mod ipc_buffer;
pub mod log_buffer;
mod models;
pub mod shared;
mod socket_server;
mod tools;
// Platform-specific module
mod platform;
// Native input injection (replaces enigo)
#[cfg(desktop)]
mod native_input;

pub use error::{Error, Result};
pub use shared::{ScreenshotParams, ScreenshotResult, WindowManagerParams, WindowManagerResult};

#[cfg(desktop)]
use desktop::TauriMcp;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the tauri-mcp APIs.
#[cfg(desktop)]
pub trait TauriMcpExt<R: Runtime> {
    fn tauri_mcp(&self) -> &TauriMcp<R>;
}

#[cfg(desktop)]
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
#[non_exhaustive]
pub struct PluginConfig {
    /// Application name (used for default socket naming)
    pub application_name: String,
    /// Socket configuration
    pub socket_type: SocketType,
    /// Whether to start the socket server automatically. Default is true.
    pub start_socket_server: bool,
    /// Default webview label to use when a window label doesn't match a WebviewWindow.
    /// In multi-webview architectures, the window "main" may contain a child webview
    /// with a different label (e.g., "preview"). Set this to that webview's label so
    /// the plugin knows where to send events and evaluate JS.
    pub default_webview_label: Option<String>,
    /// Optional auth token for socket server authentication.
    /// When set, clients must include this token in requests.
    /// When `None` (and auth has not been disabled via [`PluginConfig::insecure_no_auth`]),
    /// a random token is generated at init and written to the `.token`
    /// sidecar file that the TypeScript MCP server auto-discovers.
    pub auth_token: Option<String>,
    /// If true, run the socket server without any authentication.
    /// Any process that can reach the socket gets full control of the app
    /// (arbitrary JS, input injection, cookie access). Only set this via
    /// [`PluginConfig::insecure_no_auth`] and only when you understand the risk.
    pub disable_auth: bool,
    /// Allow the socket server to start in release builds. Off by default:
    /// this plugin is a development tool and refuses to expose its socket in
    /// release builds unless the app explicitly opts in via
    /// [`PluginConfig::allow_release_builds`].
    pub allow_release_builds: bool,
    /// If true, install the ring-buffer adapter as the global `log` logger
    /// so Rust-side `log!()` output is captured for `query_logs`. Off by
    /// default because most apps already install a logger (e.g.
    /// `tauri-plugin-log`) and `log` only allows one. JS console.* logs
    /// are always captured regardless of this flag.
    pub capture_rust_logs: bool,
    /// If true (the default), replace `window.alert`/`confirm`/`prompt`
    /// with non-blocking stubs that auto-answer (`confirm` → false,
    /// `prompt` → its default value) and record the dialog into
    /// the log buffer (target `"dialog"`, queryable via `query_logs`).
    /// Native dialogs block the webview's JS thread and would deadlock
    /// every MCP tool that round-trips through JS.
    pub stub_dialogs: bool,
    /// Command names the app wants the `manage_ipc` tool to report as
    /// available (Tauri has no runtime registry of `#[tauri::command]`
    /// handlers, so discovery is otherwise limited to observed traffic).
    pub exposed_commands: Vec<String>,
    // Construct via PluginConfig::new() + builder methods; new fields may be
    // added without a major version bump.
}

impl Default for PluginConfig {
    /// Matches `PluginConfig::new(String::new())`: the socket server starts
    /// automatically by default (`start_socket_server: true`).
    fn default() -> Self {
        Self::new(String::new())
    }
}

impl PluginConfig {
    /// Create a new plugin configuration with default values.
    pub fn new(application_name: String) -> Self {
        Self {
            application_name,
            socket_type: SocketType::default(),
            start_socket_server: true,
            default_webview_label: None,
            auth_token: None,
            disable_auth: false,
            allow_release_builds: false,
            capture_rust_logs: false,
            stub_dialogs: true,
            exposed_commands: Vec::new(),
        }
    }

    /// Declare the app's `#[tauri::command]` names so AI agents can
    /// discover them via `manage_ipc(action="commands")` without having
    /// to observe frontend traffic first.
    pub fn expose_commands<I, S>(mut self, commands: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.exposed_commands = commands.into_iter().map(Into::into).collect();
        self
    }

    /// Disable the `window.alert`/`confirm`/`prompt` stubs. Only do this if
    /// your app genuinely needs native blocking dialogs during development —
    /// a single `alert()` will hang every JS-based MCP tool until a human
    /// dismisses it.
    pub fn stub_dialogs(mut self, enable: bool) -> Self {
        self.stub_dialogs = enable;
        self
    }

    /// Enable capture of Rust-side `log!()` output into the MCP ring buffer.
    /// Only enable this if you have *not* installed another global logger
    /// (e.g. `tauri-plugin-log`) — `log` only permits a single global
    /// logger. JS console capture is unaffected by this setting.
    pub fn capture_rust_logs(mut self, enable: bool) -> Self {
        self.capture_rust_logs = enable;
        self
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

    /// Set the default webview label for multi-webview architectures.
    /// When a window label (e.g., "main") doesn't directly correspond to a WebviewWindow,
    /// this label is used to find the correct webview for JS evaluation and event emission.
    pub fn default_webview_label(mut self, label: String) -> Self {
        self.default_webview_label = Some(label);
        self
    }

    /// Set an auth token for socket server authentication.
    pub fn auth_token(mut self, token: String) -> Self {
        self.auth_token = Some(token);
        self
    }

    /// Run the socket server without authentication. By default a random
    /// token is generated when none is configured; this opt-out exists for
    /// setups where the client genuinely cannot read the `.token` sidecar
    /// file. Any process that can reach the socket then gets full control
    /// of the app (arbitrary JS, input injection, cookie access).
    pub fn insecure_no_auth(mut self) -> Self {
        self.disable_auth = true;
        self
    }

    /// Allow the socket server to start in release builds. By default the
    /// plugin refuses: the socket exposes arbitrary JS execution, native
    /// input injection, and cookie access, and must not ship to end users
    /// by accident. Only enable this for internal/dogfood builds.
    pub fn allow_release_builds(mut self, allow: bool) -> Self {
        self.allow_release_builds = allow;
        self
    }

    /// Convenience: configure TCP on localhost (127.0.0.1) with the given port.
    pub fn tcp_localhost(mut self, port: u16) -> Self {
        self.socket_type = SocketType::Tcp {
            host: "127.0.0.1".to_string(),
            port,
        };
        self
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    init_with_config(PluginConfig::default())
}

/// Initializes the plugin with the given configuration.
///
/// # Multi-instance support via environment variables
///
/// To run several copies of an app concurrently without socket collisions,
/// two environment variables are honored and take precedence over the
/// programmatic configuration (the TypeScript MCP server reads the same
/// variable names, giving symmetric per-instance configuration):
///
/// - `TAURI_MCP_IPC_PATH` — when the socket type is IPC, overrides the
///   IPC socket path (Unix domain socket path / Windows named pipe name).
/// - `TAURI_MCP_TCP_PORT` — when the socket type is TCP, overrides the
///   TCP port. Must parse as a `u16`; invalid values are ignored with a
///   warning.
/// - `TAURI_MCP_AUTH_TOKEN` — overrides the configured auth token (the
///   TypeScript MCP server reads the same variable).
///
/// # Release builds
///
/// The socket server exposes arbitrary JS execution, native input injection,
/// and cookie access to local processes. In release builds
/// (`cfg!(debug_assertions)` false) it therefore refuses to start unless the
/// app opts in with [`PluginConfig::allow_release_builds`]. The rest of the
/// plugin (log capture, guest bindings) still initializes so the app itself
/// keeps working.
pub fn init_with_config<R: Runtime>(config: PluginConfig) -> TauriPlugin<R> {
    let mut config = config;

    // Safety gate: never expose the automation socket in a release build
    // unless the app explicitly opted in. A forgotten cfg(debug_assertions)
    // around plugin registration must not become a local backdoor for end
    // users of the shipped app.
    if !cfg!(debug_assertions) && config.start_socket_server && !config.allow_release_builds {
        error!(
            "[TAURI_MCP] Refusing to start the MCP socket server in a release build. \
             This plugin grants any local process arbitrary JS execution, input \
             injection, and cookie access — it is a development tool. If this is an \
             internal build that genuinely needs it, opt in with \
             PluginConfig::allow_release_builds(true)."
        );
        config.start_socket_server = false;
    }

    // Environment overrides for multi-instance support. Env vars take
    // precedence over programmatic config.
    if let SocketType::Ipc { .. } = &config.socket_type {
        if let Ok(path) = std::env::var("TAURI_MCP_IPC_PATH") {
            if !path.is_empty() {
                info!(
                    "[TAURI_MCP] Overriding IPC socket path from TAURI_MCP_IPC_PATH env var: {}",
                    path
                );
                config.socket_type = SocketType::Ipc {
                    path: Some(std::path::PathBuf::from(path)),
                };
            }
        }
    }
    if let SocketType::Tcp { host, port } = &config.socket_type {
        if let Ok(port_str) = std::env::var("TAURI_MCP_TCP_PORT") {
            match port_str.parse::<u16>() {
                Ok(new_port) => {
                    info!(
                        "[TAURI_MCP] Overriding TCP port from TAURI_MCP_TCP_PORT env var: {} (was {})",
                        new_port, port
                    );
                    config.socket_type = SocketType::Tcp {
                        host: host.clone(),
                        port: new_port,
                    };
                }
                Err(e) => {
                    warn!(
                        "[TAURI_MCP] Ignoring invalid TAURI_MCP_TCP_PORT value '{}': {}",
                        port_str, e
                    );
                }
            }
        }
    }

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
            info!("[TAURI_MCP] Socket server will use TCP: {}:{}", host, port);
        }
    }

    // Env override for the auth token (symmetric with the TS server, which
    // reads the same variable).
    if let Ok(token) = std::env::var("TAURI_MCP_AUTH_TOKEN") {
        if !token.is_empty() {
            info!("[TAURI_MCP] Using auth token from TAURI_MCP_AUTH_TOKEN env var");
            config.auth_token = Some(token);
        }
    }

    // Auth on by default: when no token is configured, generate a random one.
    // It is written to the `<socket>.token` sidecar (0600 on Unix) which the
    // TypeScript MCP server auto-discovers on connect, so the default setup
    // stays zero-config while keeping other same-user processes out unless
    // they can also read the token file.
    if config.auth_token.is_none() {
        if config.disable_auth {
            warn!(
                "[TAURI_MCP] WARNING: Authentication explicitly disabled (insecure_no_auth). \
                 Any process that can reach the socket has full control of this app."
            );
        } else {
            config.auth_token = Some(uuid::Uuid::new_v4().simple().to_string());
            info!(
                "[TAURI_MCP] No auth token configured; generated a random token \
                 (clients discover it via the .token sidecar file)"
            );
        }
    }

    if config.start_socket_server {
        info!("[TAURI_MCP] Socket server will start automatically");
    } else {
        info!("[TAURI_MCP] Socket server auto-start is disabled");
    }

    if config.capture_rust_logs {
        // Opt-in: install the ring-buffer logger. Will fail (and no-op
        // with a warning) if another logger is already installed.
        log_buffer::install_logger();
    }

    let stub_dialogs = config.stub_dialogs;
    ipc_buffer::set_exposed_commands(config.exposed_commands.clone());

    Builder::new("mcp")
        .invoke_handler(tauri::generate_handler![
            tools::push_log::push_log,
            tools::push_ipc::push_ipc
        ])
        .on_page_load(move |webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                if !stub_dialogs {
                    // Must run before listener_patch.js, which checks this flag
                    let _ = webview.eval("window.__TAURI_MCP_DIALOG_STUB__ = false;");
                }
                let _ = webview.eval(include_str!("listener_patch.js"));
            }
        })
        .setup(move |app, api| {
            info!("[TAURI_MCP] Setting up plugin");
            #[cfg(mobile)]
            return Err("Mobile is not supported".into());
            #[cfg(desktop)]
            let tauri_mcp = desktop::init(app, api, &config)?;
            app.manage(tauri_mcp);
            info!("[TAURI_MCP] Plugin setup complete");
            Ok(())
        })
        .build()
}

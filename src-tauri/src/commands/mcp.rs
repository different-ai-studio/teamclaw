use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use super::opencode::OpenCodeState;
use crate::process_util::CommandNoWindow;

/// MCP Server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPServerConfig {
    #[serde(rename = "type")]
    pub server_type: String, // "local" | "remote"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>, // for local
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<IndexMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>, // for remote
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<IndexMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
}

/// Full opencode.json structure (partial, we only care about mcp)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OpenCodeJsonConfig {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp: Option<IndexMap<String, MCPServerConfig>>,
    #[serde(flatten)]
    pub other: IndexMap<String, Value>,
}

/// Get the path to opencode.json in the workspace
pub(crate) fn get_config_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path).join("opencode.json")
}

/// Read the opencode.json config file
pub(crate) fn read_config(workspace_path: &str) -> Result<OpenCodeJsonConfig, String> {
    let config_path = get_config_path(workspace_path);

    if !config_path.exists() {
        // Return default config if file doesn't exist
        return Ok(OpenCodeJsonConfig {
            schema: Some("https://opencode.ai/config.json".to_string()),
            mcp: None,
            other: IndexMap::new(),
        });
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read opencode.json: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse opencode.json: {}", e))
}

/// Write the opencode.json config file
pub(crate) fn write_config(
    workspace_path: &str,
    config: &OpenCodeJsonConfig,
) -> Result<(), String> {
    let config_path = get_config_path(workspace_path);

    let mut content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    content.push('\n');

    fs::write(&config_path, content).map_err(|e| format!("Failed to write opencode.json: {}", e))
}

/// Get MCP configuration from the workspace
#[tauri::command]
pub async fn get_mcp_config(
    state: State<'_, OpenCodeState>,
    workspace_path: Option<String>,
) -> Result<IndexMap<String, MCPServerConfig>, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &state)?;

    let config = read_config(&workspace_path)?;
    Ok(config.mcp.unwrap_or_default())
}

/// Save complete MCP configuration to the workspace
#[tauri::command]
pub async fn save_mcp_config(
    state: State<'_, OpenCodeState>,
    mcp_config: IndexMap<String, MCPServerConfig>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &state)?;

    let mut config = read_config(&workspace_path)?;
    config.mcp = if mcp_config.is_empty() {
        None
    } else {
        Some(mcp_config)
    };
    write_config(&workspace_path, &config)
}

/// Add a new MCP server
#[tauri::command]
pub async fn add_mcp_server(
    state: State<'_, OpenCodeState>,
    name: String,
    server_config: MCPServerConfig,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &state)?;

    let mut config = read_config(&workspace_path)?;
    let mut mcp = config.mcp.unwrap_or_default();

    if mcp.contains_key(&name) {
        return Err(format!("MCP server '{}' already exists", name));
    }

    mcp.insert(name, server_config);
    config.mcp = Some(mcp);
    write_config(&workspace_path, &config)
}

/// Update an existing MCP server
#[tauri::command]
pub async fn update_mcp_server(
    state: State<'_, OpenCodeState>,
    name: String,
    server_config: MCPServerConfig,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &state)?;

    let mut config = read_config(&workspace_path)?;
    let mut mcp = config.mcp.unwrap_or_default();

    if !mcp.contains_key(&name) {
        return Err(format!("MCP server '{}' not found", name));
    }

    mcp.insert(name, server_config);
    config.mcp = Some(mcp);
    write_config(&workspace_path, &config)
}

/// Remove an MCP server
#[tauri::command]
pub async fn remove_mcp_server(
    state: State<'_, OpenCodeState>,
    name: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &state)?;

    let mut config = read_config(&workspace_path)?;
    let mut mcp = config.mcp.unwrap_or_default();

    if !mcp.contains_key(&name) {
        return Err(format!("MCP server '{}' not found", name));
    }

    mcp.shift_remove(&name);
    config.mcp = if mcp.is_empty() { None } else { Some(mcp) };
    write_config(&workspace_path, &config)
}

/// Toggle MCP server enabled/disabled
#[tauri::command]
pub async fn toggle_mcp_server(
    state: State<'_, OpenCodeState>,
    name: String,
    enabled: bool,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &state)?;

    let mut config = read_config(&workspace_path)?;
    let mut mcp = config.mcp.unwrap_or_default();

    let server = mcp
        .get_mut(&name)
        .ok_or(format!("MCP server '{}' not found", name))?;

    server.enabled = Some(enabled);
    config.mcp = Some(mcp);
    write_config(&workspace_path, &config)
}

/// Test result for MCP server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPTestResult {
    pub success: bool,
    pub message: String,
    pub details: Option<String>,
}

/// Test an MCP server configuration
#[tauri::command]
pub async fn test_mcp_server(
    state: State<'_, OpenCodeState>,
    name: String,
    workspace_path: Option<String>,
) -> Result<MCPTestResult, String> {
    let workspace_path =
        crate::commands::team::resolve_workspace_path(workspace_path, &state)?;

    let config = read_config(&workspace_path)?;
    let mcp = config.mcp.unwrap_or_default();

    let server_config = mcp
        .get(&name)
        .ok_or(format!("MCP server '{}' not found", name))?;

    match server_config.server_type.as_str() {
        "local" => test_local_server(server_config, &workspace_path).await,
        "remote" => test_remote_server(server_config).await,
        _ => Ok(MCPTestResult {
            success: false,
            message: format!("Unknown server type: {}", server_config.server_type),
            details: None,
        }),
    }
}

/// Test a local MCP server by attempting to start it
async fn test_local_server(
    config: &MCPServerConfig,
    workspace_path: &str,
) -> Result<MCPTestResult, String> {
    let command = config
        .command
        .as_ref()
        .ok_or("Command not specified for local server")?;

    if command.is_empty() {
        return Ok(MCPTestResult {
            success: false,
            message: "Command is empty".to_string(),
            details: None,
        });
    }

    let program = &command[0];
    let args = &command[1..];

    // Try to spawn the process
    let mut cmd = TokioCommand::new(program);
    cmd.no_window();
    cmd.args(args);
    cmd.current_dir(workspace_path);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Clear ALL environment variables and only set what we need
    cmd.env_clear();

    // Set minimal required environment
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    if let Some(home) = std::env::var_os("HOME") {
        cmd.env("HOME", home);
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(dyld) = std::env::var_os("DYLD_LIBRARY_PATH") {
            cmd.env("DYLD_LIBRARY_PATH", dyld);
        }
        if let Some(dyld) = std::env::var_os("DYLD_FALLBACK_LIBRARY_PATH") {
            cmd.env("DYLD_FALLBACK_LIBRARY_PATH", dyld);
        }
    }

    // Set environment variables if provided
    if let Some(env) = &config.environment {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    // Try to start the process
    let timeout_duration = Duration::from_secs(config.timeout.unwrap_or(5));

    // Spawn the process
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Ok(MCPTestResult {
                success: false,
                message: format!("Failed to start process: {}", e),
                details: Some(format!(
                    "Make sure '{}' is installed and available in PATH. Command: {}",
                    program,
                    command.join(" ")
                )),
            });
        }
    };

    // Wait a bit to see if it stays alive, with timeout
    let wait_future = async {
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Check if process is still running
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = child.kill().await;
                Ok(MCPTestResult {
                    success: false,
                    message: format!("Process exited immediately with code: {:?}", status.code()),
                    details: Some("The MCP server process started but exited immediately. Check the command and arguments.".to_string()),
                })
            }
            Ok(None) => {
                // Process is still running, which is good
                let _ = child.kill().await;
                Ok(MCPTestResult {
                    success: true,
                    message: "MCP server started successfully".to_string(),
                    details: Some(format!(
                        "Command '{}' executed successfully and process is running.",
                        command.join(" ")
                    )),
                })
            }
            Err(e) => {
                let _ = child.kill().await;
                Ok(MCPTestResult {
                    success: false,
                    message: format!("Failed to check process status: {}", e),
                    details: None,
                })
            }
        }
    };

    // Apply timeout to the wait operation
    match timeout(timeout_duration, wait_future).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            Ok(MCPTestResult {
                success: false,
                message: "Command execution timed out".to_string(),
                details: Some(format!(
                    "The command took longer than {} seconds to start.",
                    timeout_duration.as_secs()
                )),
            })
        }
    }
}

/// Test a remote MCP server by attempting to connect to it
async fn test_remote_server(config: &MCPServerConfig) -> Result<MCPTestResult, String> {
    let url = config
        .url
        .as_ref()
        .ok_or("URL not specified for remote server")?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(config.timeout.unwrap_or(5)))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // MCP protocol uses JSON-RPC, so we'll try POST with an initialize request
    let initialize_message = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "teamclaw-test",
                "version": "0.1.0"
            }
        }
    });

    let mut post_request = client.post(url).header("Content-Type", "application/json");

    // Add headers if provided
    if let Some(headers) = &config.headers {
        for (key, value) in headers {
            post_request = post_request.header(key, value);
        }
    }

    // Try POST request first (MCP standard)
    match post_request.json(&initialize_message).send().await {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                // Try to parse response to see if it's valid JSON-RPC
                match response.text().await {
                    Ok(body) => {
                        if let Ok(_) = serde_json::from_str::<Value>(&body) {
                            Ok(MCPTestResult {
                                success: true,
                                message: format!("Successfully connected to MCP server at {}", url),
                                details: Some(format!(
                                    "Server responded with valid JSON-RPC. HTTP status: {}",
                                    status
                                )),
                            })
                        } else {
                            Ok(MCPTestResult {
                                success: false,
                                message: format!(
                                    "Server responded but not with valid JSON-RPC format"
                                ),
                                details: Some(format!(
                                    "HTTP status: {}. Response may not be a valid MCP server.",
                                    status
                                )),
                            })
                        }
                    }
                    Err(e) => Ok(MCPTestResult {
                        success: false,
                        message: format!("Failed to read response: {}", e),
                        details: Some(format!("HTTP status: {}", status)),
                    }),
                }
            } else if status == 405 {
                // Method not allowed - try GET as fallback
                return test_remote_server_get(&client, url, config).await;
            } else {
                Ok(MCPTestResult {
                    success: false,
                    message: format!("Connection failed with status: {}", status),
                    details: Some(format!("The server responded but with an error status code. MCP servers typically use POST requests.")),
                })
            }
        }
        Err(_) => {
            // If POST fails, try GET as fallback (some servers might have health check endpoints)
            test_remote_server_get(&client, url, config).await
        }
    }
}

/// Fallback: Test remote server with GET request (for health check endpoints)
async fn test_remote_server_get(
    client: &reqwest::Client,
    url: &str,
    config: &MCPServerConfig,
) -> Result<MCPTestResult, String> {
    let mut get_request = client.get(url);

    // Add headers if provided
    if let Some(headers) = &config.headers {
        for (key, value) in headers {
            get_request = get_request.header(key, value);
        }
    }

    match get_request.send().await {
        Ok(response) => {
            let status = response.status();
            if status.is_success() || status.is_redirection() {
                Ok(MCPTestResult {
                    success: true,
                    message: format!("Successfully connected to {}", url),
                    details: Some(format!("HTTP status: {}. Note: MCP protocol typically uses POST requests, but GET endpoint is accessible.", status)),
                })
            } else {
                Ok(MCPTestResult {
                    success: false,
                    message: format!("Connection failed with status: {}", status),
                    details: Some(format!("Both POST and GET requests failed. MCP servers typically require POST requests with JSON-RPC messages.")),
                })
            }
        }
        Err(e) => {
            Ok(MCPTestResult {
                success: false,
                message: format!("Failed to connect to {}", url),
                details: Some(format!("Error: {}. Make sure the URL is correct and the server is running. MCP servers typically require POST requests.", e)),
            })
        }
    }
}

/// Query a local MCP server's tools via stdio JSON-RPC.
/// Spawns the server process briefly, sends initialize + tools/list, returns tool names.
async fn query_local_server_tools(
    workspace_path: &str,
    server_config: &MCPServerConfig,
) -> Result<Vec<String>, String> {
    let command = server_config
        .command
        .as_ref()
        .ok_or("No command configured")?;
    if command.is_empty() {
        return Err("Empty command".to_string());
    }

    let program = &command[0];
    let args = &command[1..];

    let mut cmd = TokioCommand::new(program);
    cmd.no_window();
    cmd.args(args)
        .current_dir(workspace_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Clear ALL environment variables and only set what we need
    // This prevents shell function pollution (BASH_FUNC_*, etc.)
    cmd.env_clear();

    // Set minimal required environment
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    if let Some(home) = std::env::var_os("HOME") {
        cmd.env("HOME", home);
    }
    // Preserve DYLD paths on macOS
    #[cfg(target_os = "macos")]
    {
        if let Some(dyld) = std::env::var_os("DYLD_LIBRARY_PATH") {
            cmd.env("DYLD_LIBRARY_PATH", dyld);
        }
        if let Some(dyld) = std::env::var_os("DYLD_FALLBACK_LIBRARY_PATH") {
            cmd.env("DYLD_FALLBACK_LIBRARY_PATH", dyld);
        }
    }

    // Set environment variables from config
    if let Some(env) = &server_config.environment {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let _stderr = child.stderr.take();

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        mcp_tools_exchange(stdin, stdout),
    )
    .await;

    // Always kill the child process
    let _ = child.kill().await;

    match result {
        Ok(Ok(tools)) => Ok(tools),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Timeout querying MCP server tools".to_string()),
    }
}

/// Perform the MCP JSON-RPC handshake to list tools.
async fn mcp_tools_exchange(
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
) -> Result<Vec<String>, String> {
    let mut reader = BufReader::new(stdout);

    // 1. Send initialize request
    let init_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "teamclaw", "version": "1.0.0" }
        }
    });
    let mut msg = serde_json::to_string(&init_req).unwrap();
    msg.push('\n');
    stdin
        .write_all(msg.as_bytes())
        .await
        .map_err(|e| format!("Write init: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Flush init: {}", e))?;

    // 2. Read initialize response
    read_jsonrpc_response(&mut reader, 1).await?;

    // 3. Send initialized notification
    let notif = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    let mut msg = serde_json::to_string(&notif).unwrap();
    msg.push('\n');
    stdin
        .write_all(msg.as_bytes())
        .await
        .map_err(|e| format!("Write notif: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Flush notif: {}", e))?;

    // 4. Send tools/list request
    let tools_req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    let mut msg = serde_json::to_string(&tools_req).unwrap();
    msg.push('\n');
    stdin
        .write_all(msg.as_bytes())
        .await
        .map_err(|e| format!("Write tools/list: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Flush tools/list: {}", e))?;

    // 5. Read tools/list response
    let resp = read_jsonrpc_response(&mut reader, 2).await?;

    // Extract tool names from response
    let tools = resp
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(tools)
}

/// Read lines from the MCP server until we get a JSON-RPC response matching the given id.
async fn read_jsonrpc_response(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    expected_id: u64,
) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            return Err("Server closed stdout".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(json) = serde_json::from_str::<Value>(trimmed) {
            // Check if this is a response (has "id" field) matching our expected id
            if let Some(id) = json.get("id") {
                let id_matches = id.as_u64() == Some(expected_id)
                    || id.as_str() == Some(&expected_id.to_string());
                if id_matches {
                    return Ok(json);
                }
            }
            // Otherwise it's a notification or mismatched response — skip it
        }
    }
}

/// List tools for all enabled MCP servers by querying each one directly.
#[tauri::command]
pub async fn list_mcp_tools(
    state: State<'_, OpenCodeState>,
) -> Result<HashMap<String, Vec<String>>, String> {
    let workspace_path = super::opencode::current_workspace_path(&state)?;

    let config = read_config(&workspace_path)?;
    let servers = config.mcp.unwrap_or_default();

    let mut result = HashMap::new();

    // Query each enabled server concurrently
    let mut handles = Vec::new();
    for (name, server_config) in &servers {
        if server_config.enabled == Some(false) {
            continue;
        }
        // Only support local servers for now (stdio transport)
        if server_config.server_type != "local" {
            continue;
        }
        let name = name.clone();
        let config = server_config.clone();
        let ws = workspace_path.clone();
        handles.push(tokio::spawn(async move {
            let tools = query_local_server_tools(&ws, &config)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("[MCP] Failed to list tools for {}: {}", name, e);
                    Vec::new()
                });
            (name, tools)
        }));
    }

    for handle in handles {
        if let Ok((name, tools)) = handle.await {
            if !tools.is_empty() {
                result.insert(name, tools);
            }
        }
    }

    Ok(result)
}

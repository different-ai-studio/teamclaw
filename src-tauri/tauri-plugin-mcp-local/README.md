# Tauri Plugin: Model Context Protocol (MCP)

A comprehensive Tauri plugin and MCP server that bridges AI agents (Claude Code, Cursor, Cline, etc.) with your Tauri desktop applications, enabling intelligent debugging, testing, and automation capabilities.

## Overview

The Model Context Protocol (MCP) is an open protocol that standardizes how AI assistants interact with external systems. This plugin implements MCP for Tauri applications, allowing AI agents to:

- **Debug visually** by taking screenshots and analyzing UI state
- **Automate testing** through simulated user interactions
- **Inspect application state** via DOM access and storage inspection
- **Execute JavaScript** in the application context for advanced debugging
- **Control windows** programmatically for multi-window testing scenarios

### Why Use This Plugin?

Traditional debugging requires manual reproduction of issues and visual inspection. With this MCP plugin, AI agents can:

1. **See what you see** - Take screenshots to understand visual bugs
2. **Do what you do** - Simulate clicks, typing, and navigation
3. **Know what's inside** - Access DOM, localStorage, and application state
4. **Fix autonomously** - Execute JavaScript to test fixes in real-time

This is particularly powerful for:
- **Debugging visual regressions** - AI can compare screenshots before/after changes
- **Automated UI testing** - Generate and execute test scenarios
- **Cross-platform validation** - Verify behavior across different OS windows
- **State inspection** - Diagnose issues by examining storage and DOM structure

## About This Project

This plugin is based on the original [tauri-plugin-mcp](https://github.com/P3GLEG/tauri-plugin-mcp) by P3GLEG, and has been **heavily modified and improved** with:

### Major Enhancements

- **Console & Error Tracking**: New tools for capturing console logs and exceptions
- **Comprehensive Documentation**:
  - Complete Quick Start guide
  - Tool Parameters Reference
  - AI Agent Usage Guide with debugging workflows
  - Detailed Development Workflow guide
  - Common debugging patterns and best practices
- **Enhanced Developer Experience**:
  - Pre-commit checklist
  - Step-by-step guide for adding new tools
  - Code templates for Rust and TypeScript
  - Testing strategies and examples
- **Production-Ready**: Extensive troubleshooting guide and error handling
- **Better Organization**: Structured documentation with clear examples

### Attribution

Original work: [P3GLEG/tauri-plugin-mcp](https://github.com/P3GLEG/tauri-plugin-mcp)
License: MIT (see [LICENSE](LICENSE))

We're grateful to P3GLEG for creating the foundation of this plugin. This fork aims to provide a more comprehensive, production-ready solution with extensive documentation for both AI agents and human developers.

## 📚 Documentation

**New to MCP?** Start with our comprehensive guides:

- **[Quick Start Guide](docs/QUICK_START.md)** - Get running in 15 minutes
- **[Integration Guide](docs/INTEGRATION_GUIDE.md)** - Complete setup and configuration
- **[Testing Guide](docs/TESTING_GUIDE.md)** - Master AI-powered testing
- **[Docs Overview](docs/README.md)** - Documentation hub

**Below:** Quick reference for the main README. See the guides above for step-by-step instructions.

## Quick Start

Want to get started immediately? Here's the minimal setup:

```bash
# 1. Add to your Tauri app's Cargo.toml
tauri-plugin-mcp = { path = "../.tauri-plugin-mcp" }

# 2. Register in src-tauri/src/main.rs (debug builds only!)
#[cfg(debug_assertions)]
{
    use tauri_plugin_mcp::PluginConfig;
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        PluginConfig::new("YourApp".to_string())
            .start_socket_server(true)
            .socket_path("/tmp/tauri-mcp.sock")  // macOS/Linux
    ));
}

# 3. Build the MCP server
cd .tauri-plugin-mcp/mcp-server-ts
pnpm install && pnpm build

# 4. Configure your AI agent (Claude Code/Cursor/Cline)
# Add to ~/.config/claude/claude_code_config.json:
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/.tauri-plugin-mcp/mcp-server-ts/build/index.js"]
    }
  }
}

# 5. Start your Tauri app and test!
pnpm run tauri dev
```

Now AI agents can debug your app! See [Getting Started](#getting-started) for detailed setup.

## Available MCP Tools - Quick Reference

| Tool | Purpose | Common Use Case |
|------|---------|-----------------|
| **take_screenshot** | Capture window or element images | Visual regression testing, bug reporting |
| **get_dom** | Retrieve HTML structure | Debugging dynamic content, state inspection |
| **execute_js** | Run JavaScript in webview | State inspection, API calls, framework access |
| **get_element_position** | Find element coordinates | Preparing for mouse clicks, layout debugging |
| **inject_console_capture** | Enable console log collection | Capture console.log/error/warn messages |
| **get_console_logs** | Retrieve captured logs | Debugging runtime errors, log analysis |
| **inject_error_tracker** | Enable exception tracking | Capture unhandled errors, promise rejections |
| **get_exceptions** | Retrieve tracked errors | Understanding crash causes, error patterns |
| **local_storage_get** | Read localStorage item | Session debugging, auth token inspection |
| **local_storage_set** | Write localStorage item | Testing state persistence, setting up test data |
| **local_storage_remove** | Delete localStorage item | Cleanup, testing deletion flows |
| **local_storage_clear** | Clear all localStorage | Reset to clean state |
| **local_storage_get_all** | Retrieve all storage | Complete state inspection |
| **manage_window** | Control window properties | Multi-window testing, positioning, focus |
| **health_check** | Verify plugin connectivity | Connection diagnostics, startup verification |
| **ping** | Simple connectivity test | Basic health check |

See [Features](#features) for detailed documentation of each tool.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AI Agent (Claude/Cursor)                 │
│                  (MCP Client via stdio/SSE)                  │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            │ MCP Protocol
                            │ (JSON-RPC)
                            │
┌───────────────────────────▼─────────────────────────────────┐
│              MCP Server (TypeScript - Node.js)               │
│  • Implements MCP protocol                                   │
│  • Exposes tools to AI agents                                │
│  • Manages socket connection lifecycle                       │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            │ IPC Socket or TCP
                            │ (JSON commands)
                            │
┌───────────────────────────▼─────────────────────────────────┐
│         Tauri Plugin (Rust - Socket Server)                  │
│  • Listens on Unix socket/Named pipe/TCP                     │
│  • Processes JSON commands                                   │
│  • Executes Tauri API calls                                  │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            │ Tauri IPC
                            │
┌───────────────────────────▼─────────────────────────────────┐
│              Your Tauri Application                          │
│  • Frontend (React/Vue/Svelte/etc.)                          │
│  • Webview rendering                                         │
│  • Application logic                                         │
└─────────────────────────────────────────────────────────────┘
```

### Component Breakdown

#### 1. **Tauri Plugin (Rust)**
- **Socket Server** (`socket_server.rs`): Manages persistent connections via IPC or TCP
- **Tool Implementations** (`src/tools/*.rs`): Individual Rust modules for each capability
- **Tauri Integration**: Hooks into Tauri's window and webview APIs

#### 2. **MCP Server (TypeScript)**
- **Client Connection** (`client.ts`): Connects to the Tauri plugin's socket
- **Tool Registry** (`src/tools/*.ts`): Maps MCP tool calls to socket commands
- **Protocol Handler**: Implements MCP specification for AI agent communication

#### 3. **Communication Flow**
```
AI Request → MCP Server → Socket → Tauri Plugin → Tauri API → App
                    ←       ←        ←            ←         ←
           AI Response   JSON    Rust Handler   Result   Effect
```

## Features

### Window Interaction

#### Take Screenshot
Capture high-quality images of any Tauri window with pixel-perfect accuracy.

**Use Cases:**
- Visual regression testing
- Bug reporting with context
- UI state verification
- Automated documentation generation

**Capabilities:**
- Configure JPEG quality (1-100)
- Specify exact dimensions or use window size
- Target specific windows in multi-window apps
- Base64 or file output

**Example:** AI can take a screenshot, analyze the UI, and tell you "The submit button is misaligned 3px to the right."

#### Window Management
Full programmatic control over window lifecycle and properties.

**Capabilities:**
- Position: Set x, y coordinates
- Size: Resize width and height
- State: Minimize, maximize, restore, focus
- Multi-window: Target specific windows by label
- Visibility: Show, hide, bring to front

**Use Cases:**
- Multi-window testing scenarios
- Window positioning tests
- Focus management debugging
- Screen layout automation

#### DOM Access
Retrieve the complete HTML structure and content from any webview.

**Capabilities:**
- Full DOM tree extraction
- JavaScript evaluation context
- Element inspection
- Computed styles and properties (via JS execution)

**Use Cases:**
- Debugging dynamic content
- Validating data-binding
- Analyzing generated markup
- State inspection without DevTools

**Example:** AI can read the DOM, find a specific element by selector, and verify its content or attributes.

### User Input Simulation

#### Mouse Movement
Simulate realistic mouse interactions with pixel-perfect accuracy.

**Capabilities:**
- Click: Left, right, middle button clicks
- Double-click and triple-click
- Movement: Absolute and relative positioning
- Scrolling: Vertical and horizontal with delta control
- Hold and drag operations

**Use Cases:**
- Automated UI testing
- Click-through flow validation
- Hover state testing
- Drag-and-drop testing

**Example:** AI can click a button, verify the result via screenshot, and continue a multi-step workflow.

#### Text Input
Programmatically input text into focused elements with keyboard simulation.

**Capabilities:**
- Type into any focused input/textarea
- Simulate keyboard events
- Special characters and modifiers
- Paste large text blocks

**Use Cases:**
- Form filling automation
- Input validation testing
- Search functionality testing
- Text editor interaction

**Example:** AI can fill out a form, submit it, and verify the submission success.

#### Execute JavaScript
Run arbitrary JavaScript code directly in your application's webview context.

**Capabilities:**
- Full access to window scope
- Return values to the plugin
- Async/await support
- Error handling and reporting

**Use Cases:**
- Advanced state inspection
- Dynamic testing scenarios
- Direct API calls
- Framework-specific interactions (React state, Vue store, etc.)

**Example:** AI can execute `window.store.getState()` to inspect Redux state, or call application methods directly.

### Data & Storage

#### Local Storage Management
Complete CRUD operations on browser localStorage.

**Capabilities:**
- Get: Retrieve individual items or all entries
- Set: Add or update key-value pairs
- Remove: Delete specific keys
- Clear: Wipe all storage

**Use Cases:**
- State persistence testing
- Cache debugging
- User preferences inspection
- Session data validation

**Example:** AI can check localStorage for authentication tokens, verify expiration, and test refresh flows.

#### Ping
Simple connectivity test to verify the plugin is responsive.

**Use Cases:**
- Connection health monitoring
- Startup verification
- Debugging connection issues
- Integration testing

## Tool Parameters Reference

Detailed parameter specifications for each MCP tool:

### Screenshot Tools

#### take_screenshot
```typescript
{
  quality?: number;        // JPEG quality 1-100 (default: 90)
  width?: number;         // Target width in pixels (optional)
  height?: number;        // Target height in pixels (optional)
  window_label?: string;  // Target window (default: main window)
}
```

### DOM & Inspection Tools

#### get_dom
```typescript
{
  window_label?: string;  // Target window (default: main window)
}
```

#### get_element_position
```typescript
{
  selector: string;       // CSS selector (required)
  window_label?: string;  // Target window (default: main window)
}
```

#### execute_js
```typescript
{
  script: string;         // JavaScript code to execute (required)
  window_label?: string;  // Target window (default: main window)
}
```

### Console & Error Tracking

#### inject_console_capture
```typescript
{
  window_label?: string;  // Target window (default: main window)
}
```

#### get_console_logs
```typescript
{
  level?: "log" | "warn" | "error" | "info" | "debug";  // Filter by level
  since?: number;         // Unix timestamp - only logs after this time
  limit?: number;         // Max number of logs to return
  window_label?: string;  // Target window
}
```

#### inject_error_tracker
```typescript
{
  window_label?: string;  // Target window (default: main window)
}
```

#### get_exceptions
```typescript
{
  since?: number;         // Unix timestamp - only errors after this time
  limit?: number;         // Max number of errors to return
  window_label?: string;  // Target window
}
```

### Storage Tools

#### local_storage_get
```typescript
{
  key: string;            // Storage key (required)
  window_label?: string;  // Target window
}
```

#### local_storage_set
```typescript
{
  key: string;            // Storage key (required)
  value: string;          // Value to store (required)
  window_label?: string;  // Target window
}
```

#### local_storage_remove
```typescript
{
  key: string;            // Storage key (required)
  window_label?: string;  // Target window
}
```

#### local_storage_clear
```typescript
{
  window_label?: string;  // Target window
}
```

#### local_storage_get_all
```typescript
{
  window_label?: string;  // Target window
}
```

### Window Management

#### manage_window
```typescript
{
  action: "resize" | "move" | "focus" | "minimize" | "maximize" | "restore";
  window_label?: string;  // Target window (default: main window)
  x?: number;            // X position for move action
  y?: number;            // Y position for move action
  width?: number;        // Width for resize action
  height?: number;       // Height for resize action
}
```

### Diagnostics

#### health_check
```typescript
{}  // No parameters required
```

#### ping
```typescript
{}  // No parameters required
```

## Getting Started

### Prerequisites

- **Rust** (latest stable): For Tauri development
- **Node.js** 18+: For the MCP server
- **pnpm** (recommended) or npm: Package management
- **Tauri CLI**: `cargo install tauri-cli`

### Step 1: Build the Plugin

First, build both the Rust plugin and TypeScript MCP server:

```bash
# Install dependencies
pnpm install

# Build the Rust plugin and TypeScript server
pnpm run build && pnpm run build-plugin
```

This will:
1. Compile the Rust plugin (`tauri-plugin-mcp`)
2. Build the TypeScript MCP server (`mcp-server-ts/build/`)

### Step 2: Integrate into Your Tauri App

#### 2.1 Add Dependency

If you don't have a Tauri app yet, follow [Tauri's quickstart guide](https://v2.tauri.app/start/create-project/).

In your app's `src-tauri/Cargo.toml`, add the plugin dependency:

```toml
[dependencies]
tauri-plugin-mcp = { path = "../path/to/tauri-plugin-mcp" }
# Or from a git repository:
# tauri-plugin-mcp = { git = "https://github.com/yourusername/tauri-plugin-mcp" }
```

In your app's `package.json`, add the guest bindings:

```json
{
  "dependencies": {
    "tauri-plugin-mcp": "file:../path/to/tauri-plugin-mcp"
  }
}
```

#### 2.2 Register the Plugin

**IMPORTANT SECURITY NOTE:** Only enable MCP in development builds. This plugin provides deep access to your application and should NEVER be included in production.

In your `src-tauri/src/main.rs` (or `lib.rs` for mobile):

```rust
use tauri_plugin_mcp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Only enable MCP in development builds
    #[cfg(debug_assertions)]
    {
        use tauri_plugin_mcp::PluginConfig;

        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            PluginConfig::new("YourAppName".to_string())  // Must match your app's window name
                .start_socket_server(true)
                // Choose ONE connection mode:

                // Option 1: IPC Socket (Default - Recommended)
                .socket_path("/tmp/tauri-mcp.sock")  // macOS/Linux
                // .socket_path("\\\\.\\pipe\\tauri-mcp")  // Windows

                // Option 2: TCP Socket (Useful for Docker/Remote debugging)
                // .tcp("127.0.0.1".to_string(), 4000)
        ));

        log::info!("MCP plugin enabled for development");
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Configuration Options:**

- **`PluginConfig::new(app_name)`**: The application name used to identify windows (must match your `tauri.conf.json` title)
- **`.start_socket_server(true)`**: Enables the socket server (required)
- **`.socket_path(path)`**: IPC socket location (Unix socket on macOS/Linux, Named Pipe on Windows)
- **`.tcp(host, port)`**: TCP socket configuration (alternative to IPC)

**Platform-Specific Socket Paths:**

- **macOS/Linux**: `/tmp/tauri-mcp.sock` (or any path in `/tmp`)
- **Windows**: `\\\\.\\pipe\\tauri-mcp` (Named Pipe format)

### Step 3: Configure MCP Server for Your AI Agent

The MCP server acts as a bridge between AI agents (Claude Code, Cursor, Cline) and your Tauri application.

#### 3.1 Build the MCP Server

```bash
cd mcp-server-ts
pnpm install
pnpm build
```

This creates `mcp-server-ts/build/index.js`, the entry point for AI agents.

#### 3.2 Configure Your AI Agent

Add the MCP server to your AI agent's configuration file:

**For Claude Code** (`~/.config/claude/claude_code_config.json` or `claude_desktop_config.json`):
**For Cursor** (`.cursor/mcp-config.json`):
**For Cline** (VSCode settings):

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/tauri-plugin-mcp/mcp-server-ts/build/index.js"]
    }
  }
}
```

**Replace `/absolute/path/to/` with the actual path on your system.**

#### Configuration Modes

##### Mode 1: IPC Socket (Default - Recommended)

Best for local development with lowest overhead. Uses platform-specific inter-process communication.

**Default Configuration (no env vars needed):**
```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["/path/to/mcp-server-ts/build/index.js"]
    }
  }
}
```

**Custom Socket Path:**
```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["/path/to/mcp-server-ts/build/index.js"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/custom/path/to/socket"
      }
    }
  }
}
```

**Platform-specific defaults:**
- macOS/Linux: `/tmp/tauri-mcp.sock`
- Windows: `\\\\.\\pipe\\tauri-mcp`

##### Mode 2: TCP Socket

Use TCP when:
- Running Tauri app in Docker
- Remote debugging across network
- IPC socket permissions issues
- Testing from multiple machines

**Configuration:**
```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["/path/to/mcp-server-ts/build/index.js"],
      "env": {
        "TAURI_MCP_CONNECTION_TYPE": "tcp",
        "TAURI_MCP_TCP_HOST": "127.0.0.1",
        "TAURI_MCP_TCP_PORT": "4000"
      }
    }
  }
}
```

**Corresponding Tauri plugin configuration:**
```rust
#[cfg(debug_assertions)]
{
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        PluginConfig::new("YourApp".to_string())
            .start_socket_server(true)
            .tcp("127.0.0.1".to_string(), 4000)  // Must match MCP server config
    ));
}
```

**Security Warning:** TCP sockets expose your application to network connections. Use `127.0.0.1` (localhost) to prevent external access. Never use `0.0.0.0` in production-like environments.

#### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `TAURI_MCP_CONNECTION_TYPE` | `ipc` | Connection mode: `ipc` or `tcp` |
| `TAURI_MCP_IPC_PATH` | Platform-specific | Custom IPC socket path |
| `TAURI_MCP_TCP_HOST` | `127.0.0.1` | TCP server host (TCP mode only) |
| `TAURI_MCP_TCP_PORT` | `3000` | TCP server port (TCP mode only) |

## How It Works: Communication Flow

Understanding the communication flow helps with debugging and extending the plugin.

### Request/Response Cycle

```
1. AI Agent sends MCP request
   ↓
2. MCP Server receives tool call (e.g., "take_screenshot")
   ↓
3. MCP Server constructs JSON command
   {
     "action": "take_screenshot",
     "params": { "quality": 80 }
   }
   ↓
4. Socket Client sends command to Socket Server (IPC or TCP)
   ↓
5. Socket Server (Rust) receives JSON command
   ↓
6. Router dispatches to appropriate tool handler
   ↓
7. Tool handler calls Tauri API
   (e.g., window.screenshot())
   ↓
8. Result returned as JSON
   {
     "success": true,
     "data": { "image": "base64..." }
   }
   ↓
9. Socket Client receives response
   ↓
10. MCP Server formats response per MCP protocol
   ↓
11. AI Agent receives result
```

### Component Details

#### Socket Server (Rust - `socket_server.rs`)

**Responsibilities:**
- Creates and manages socket listeners (IPC or TCP)
- Accepts incoming connections with persistent support
- Deserializes JSON commands from clients
- Routes commands to appropriate tool handlers
- Serializes responses back to JSON
- Handles errors and connection lifecycle

**Key Features:**
- **Persistent Connections**: Supports multiple requests per connection
- **Concurrent Clients**: Handle multiple AI agents simultaneously
- **Error Recovery**: Graceful handling of malformed requests
- **Type Safety**: Strongly-typed command/response structures

**Implementation:**
```rust
// Simplified example
match command.action.as_str() {
    "take_screenshot" => {
        let params: ScreenshotParams = serde_json::from_value(command.params)?;
        let result = tools::take_screenshot(&app, params).await?;
        Ok(json!({ "success": true, "data": result }))
    }
    // ... other actions
}
```

#### Socket Client (TypeScript - `client.ts`)

**Responsibilities:**
- Establishes connection to socket (IPC or TCP)
- Sends JSON-serialized commands
- Awaits and deserializes responses
- Implements retry logic for connection failures
- Manages connection pooling/reuse

**Key Features:**
- **Promise-based API**: Async/await support
- **Automatic Reconnection**: Retry failed connections
- **Timeout Handling**: Prevent hung requests
- **Type Definitions**: TypeScript interfaces for all commands

**Implementation:**
```typescript
// Simplified example
async function sendCommand(action: string, params: any): Promise<any> {
    const command = { action, params };
    await socket.write(JSON.stringify(command) + '\n');
    const response = await socket.readLine();
    return JSON.parse(response);
}
```

#### MCP Server (TypeScript - `mcp-server-ts/`)

**Responsibilities:**
- Implements MCP protocol specification
- Registers available tools with descriptions
- Translates MCP tool calls to socket commands
- Formats responses according to MCP schema
- Handles stdio communication with AI agents

**Tool Registration Example:**
```typescript
server.registerTool({
    name: "take_screenshot",
    description: "Capture a screenshot of the Tauri window",
    inputSchema: {
        type: "object",
        properties: {
            quality: { type: "number", minimum: 1, maximum: 100 }
        }
    }
});
```

## Troubleshooting

### Diagnostic Steps

Before diving into specific issues, follow this diagnostic checklist:

1. **Verify Tauri app is running in debug mode**
   ```bash
   pnpm run tauri dev
   # Look for log: "MCP plugin enabled for development"
   ```

2. **Check socket file exists** (IPC mode only)
   ```bash
   # macOS/Linux
   ls -l /tmp/tauri-mcp.sock

   # Windows PowerShell
   Get-ChildItem \\.\pipe\ | Select-String tauri-mcp
   ```

3. **Test socket connectivity** (TCP mode only)
   ```bash
   # macOS/Linux
   nc -zv 127.0.0.1 4000

   # Windows
   Test-NetConnection -ComputerName 127.0.0.1 -Port 4000
   ```

4. **Check MCP server logs**
   - AI agent logs usually show MCP server stdout/stderr
   - Look for connection attempts and errors

### Common Issues

#### Issue 1: "Connection refused" or "ECONNREFUSED"

**Symptoms:** MCP server cannot connect to the Tauri plugin.

**Causes & Solutions:**

- **Tauri app not running**: Start your app with `pnpm run tauri dev`
- **Socket server disabled**: Verify `.start_socket_server(true)` in plugin config
- **Mismatched connection modes**: Ensure both MCP server and Tauri plugin use the same mode (IPC or TCP)
- **Port mismatch (TCP)**: Verify port numbers match exactly:
  ```rust
  // Tauri: .tcp("127.0.0.1".to_string(), 4000)
  // MCP Server env: TAURI_MCP_TCP_PORT=4000
  ```

**Debug commands:**
```bash
# Check if socket server is listening (TCP mode)
lsof -i :4000  # macOS/Linux
netstat -an | findstr :4000  # Windows

# Check Tauri app logs
# Look for: "Socket server started on..."
```

#### Issue 2: "Socket file not found" (IPC mode)

**Symptoms:** Error mentioning socket path doesn't exist.

**Causes & Solutions:**

- **Socket not created**: Tauri app may have failed to start the socket server
  - Check Tauri logs for socket creation errors
  - Verify path has write permissions (try `/tmp` on Unix)

- **Wrong socket path**: Ensure paths match exactly:
  ```rust
  // Tauri
  .socket_path("/tmp/tauri-mcp.sock")
  ```
  ```json
  // MCP Server (if custom path)
  "env": { "TAURI_MCP_IPC_PATH": "/tmp/tauri-mcp.sock" }
  ```

- **Path cleared on reboot**: `/tmp` may be cleared on system restart
  - Restart your Tauri app to recreate the socket

**Workaround:** Switch to TCP mode which doesn't use file system.

#### Issue 3: "Permission denied" (IPC mode)

**Symptoms:** Socket file exists but cannot be accessed.

**Causes & Solutions:**

- **File permissions**: Check socket file permissions
  ```bash
  ls -l /tmp/tauri-mcp.sock
  # Should be readable/writable by your user
  ```

- **SELinux/AppArmor (Linux)**: Security modules may block socket access
  ```bash
  # Temporary disable SELinux (for testing only)
  sudo setenforce 0
  ```

- **Windows named pipe permissions**: Ensure correct pipe name format
  ```rust
  .socket_path("\\\\.\\pipe\\tauri-mcp")  // Correct format
  ```

**Workaround:** Use TCP mode to avoid file system permissions.

#### Issue 4: Connection drops after each request

**Symptoms:** Each tool call requires reconnection; slow responses.

**Causes & Solutions:**

- **Outdated plugin version**: Ensure you're using the latest version with persistent connection support
- **Short timeouts**: Increase client timeout settings
- **Server-side errors**: Check Tauri logs for panics or errors that might kill connections

**Fix:**
```bash
cd tauri-plugin-mcp
git pull
pnpm run build && pnpm run build-plugin
```

#### Issue 5: "Tool not found" or tool calls fail

**Symptoms:** AI agent says tool doesn't exist or returns errors.

**Causes & Solutions:**

- **MCP server not built**: Rebuild the MCP server
  ```bash
  cd mcp-server-ts
  pnpm build
  ```

- **Tool not registered**: Check `mcp-server-ts/src/tools/index.ts` includes the tool
- **Schema mismatch**: Ensure tool parameters match the expected schema

**Debug:**
```bash
# List available tools using MCP Inspector
cd mcp-server-ts
npx @modelcontextprotocol/inspector node build/index.js
# Click "List Tools" to see registered tools
```

#### Issue 6: Screenshots are black or empty

**Symptoms:** Screenshot tool returns blank or all-black images.

**Causes & Solutions:**

- **Wrong window name**: Application name must match window title
  ```rust
  PluginConfig::new("ExactAppName".to_string())  // Must match tauri.conf.json
  ```

- **Window not focused/visible**: Ensure window is visible and not minimized
- **Webview not loaded**: Wait for app to fully load before taking screenshots
- **macOS permissions**: Grant screen recording permission to your terminal/IDE
  - System Preferences → Security & Privacy → Screen Recording

#### Issue 7: JavaScript execution fails

**Symptoms:** `execute_js` tool returns errors or undefined.

**Causes & Solutions:**

- **Webview not ready**: Ensure DOM is loaded before executing JS
- **Syntax errors**: Validate JavaScript syntax
- **CSP restrictions**: Content Security Policy may block inline scripts
- **Return value serialization**: Ensure returned values are JSON-serializable

**Example:**
```typescript
// Bad: Returns DOM element (not serializable)
execute_js({ script: "document.getElementById('app')" })

// Good: Returns serializable data
execute_js({ script: "document.getElementById('app').textContent" })
```

### Testing Your Setup

#### Using MCP Inspector

The official MCP Inspector provides a GUI for testing your server:

```bash
cd mcp-server-ts

# IPC mode (default)
npx @modelcontextprotocol/inspector node build/index.js

# TCP mode
TAURI_MCP_CONNECTION_TYPE=tcp \
TAURI_MCP_TCP_HOST=127.0.0.1 \
TAURI_MCP_TCP_PORT=4000 \
npx @modelcontextprotocol/inspector node build/index.js

# Windows (TCP mode)
set TAURI_MCP_CONNECTION_TYPE=tcp&& set TAURI_MCP_TCP_HOST=127.0.0.1&& set TAURI_MCP_TCP_PORT=4000&& npx @modelcontextprotocol/inspector node build\index.js
```

The Inspector allows you to:
- List all available tools
- View tool schemas and descriptions
- Execute tools with custom parameters
- See real-time request/response logs

#### Manual Testing

Test the socket connection directly:

```bash
# Test TCP socket
echo '{"action":"ping","params":{}}' | nc 127.0.0.1 4000

# Test Unix socket (macOS/Linux)
echo '{"action":"ping","params":{}}' | nc -U /tmp/tauri-mcp.sock
```

Expected response:
```json
{"success":true,"data":"pong"}
```

### Getting Help

If you're still stuck after trying these solutions:

1. **Check logs**: Collect logs from both Tauri app and MCP server
2. **Minimal reproduction**: Create a minimal Tauri app that reproduces the issue
3. **Open an issue**: Include:
   - Operating system and version
   - Tauri version (`cargo tauri info`)
   - Connection mode (IPC or TCP)
   - Full error messages and stack traces
   - Configuration files (plugin config and MCP server config)

## AI Agent Usage Guide

This section provides guidance for AI agents (like Claude Code, Cursor, Cline) on how to effectively use this plugin for debugging Tauri applications.

### Recommended Debugging Workflow

When debugging a Tauri application, follow this systematic approach:

#### 1. **Verify Connectivity**

Always start by verifying the plugin is accessible:

```typescript
// Step 1: Health check
await health_check({});

// Step 2: Ping test
await ping({});
```

**What to check:**
- Plugin is loaded and responsive
- Socket connection is working
- MCP server can communicate with Tauri app

#### 2. **Set Up Monitoring**

Before investigating issues, set up monitoring for runtime errors and logs:

```typescript
// Enable console log capture
await inject_console_capture({});

// Enable error tracking
await inject_error_tracker({});
```

**Why this matters:**
- Captures errors that occur during your investigation
- Logs provide context about what the app is doing
- Prevents missing important diagnostic information

#### 3. **Understand Visual State**

Take a screenshot to understand what the user is seeing:

```typescript
// Capture current visual state
const screenshot = await take_screenshot({ quality: 80 });

// Analyze the screenshot to understand:
// - Is the UI rendered correctly?
// - Are there visual errors?
// - Which elements are visible?
```

**Use screenshots for:**
- Visual regression detection
- Confirming UI state before/after actions
- Identifying layout issues
- Documenting bugs

#### 4. **Inspect DOM Structure**

Examine the HTML structure to understand the application state:

```typescript
// Get full DOM
const dom = await get_dom({});

// Or find specific elements
const buttonPos = await get_element_position({
    selector: "button.submit"
});
```

**Look for:**
- Missing or unexpected elements
- Incorrect attributes or classes
- Dynamic content issues
- Framework-specific data attributes

#### 5. **Check Application State**

Inspect application state using JavaScript execution:

```typescript
// Check React state (if using React)
const state = await execute_js({
    script: `
        const app = document.getElementById('root');
        const fiber = app._reactRootContainer?._internalRoot?.current;
        // Return serializable state information
        JSON.stringify({ /* state data */ });
    `
});

// Check localStorage for session data
const storage = await local_storage_get_all({});

// Check specific configuration
const config = await execute_js({
    script: "JSON.stringify(window.__APP_CONFIG__ || {})"
});
```

**Common state sources:**
- Redux store: `window.store?.getState()`
- Zustand: `window.useStore?.getState()`
- Vue store: `window.app?.$store?.state`
- Local/session storage
- Global configuration objects

#### 6. **Review Runtime Logs**

Check console logs and errors for diagnostic information:

```typescript
// Get recent error messages
const errors = await get_exceptions({
    since: Date.now() - 60000,  // Last minute
    limit: 50
});

// Get console logs
const logs = await get_console_logs({
    level: "error",
    since: Date.now() - 60000
});

// Analyze patterns:
// - Are there recurring errors?
// - What was the sequence of events?
// - Are there unhandled promise rejections?
```

#### 7. **Form and Test Hypotheses**

Based on the information gathered, form hypotheses and test them:

```typescript
// Example: Testing if a specific function exists
const hasFunction = await execute_js({
    script: "typeof window.myFunction === 'function'"
});

// Example: Testing if data loaded
const dataLoaded = await execute_js({
    script: `
        const data = window.myData;
        JSON.stringify({
            exists: !!data,
            length: data?.length || 0,
            isEmpty: !data || data.length === 0
        });
    `
});

// Example: Testing localStorage state
const authState = await local_storage_get({ key: "auth_token" });
```

### Best Practices for AI Agents

#### Do's

1. **Always verify connectivity first** - Use `health_check()` or `ping()` before attempting other operations

2. **Set up monitoring early** - Call `inject_console_capture()` and `inject_error_tracker()` at the start of debugging sessions

3. **Take screenshots before and after actions** - Document visual changes to understand impact

4. **Use execute_js for complex queries** - Batch multiple checks into a single JavaScript execution to reduce round trips

5. **Check logs after each significant action** - Use `get_console_logs()` and `get_exceptions()` to catch errors immediately

6. **Clean up test data** - Use `local_storage_clear()` or `local_storage_remove()` to reset state between tests

7. **Be specific with selectors** - Use precise CSS selectors in `get_element_position()` to avoid ambiguity

8. **Handle errors gracefully** - Wrap tool calls in try-catch and provide helpful context when operations fail

#### Don'ts

1. **Don't assume the plugin is always available** - Always verify connectivity, especially in new sessions

2. **Don't skip visual verification** - Screenshots provide critical context that logs cannot

3. **Don't execute untrusted code** - Only run JavaScript that you've verified is safe

4. **Don't ignore TypeScript types** - Use the parameter types defined in the Tool Parameters Reference

5. **Don't overwhelm with requests** - Batch operations when possible to reduce overhead

6. **Don't forget about multi-window apps** - Use `window_label` parameter to target specific windows

7. **Don't assume synchronous execution** - All operations are async; use await properly

8. **Don't leave monitoring enabled in production** - Console/error tracking is for debugging only

### Common Debugging Patterns

#### Pattern 1: Debugging a Form Submission Issue

```typescript
// 1. Verify form is visible
const screenshot = await take_screenshot({});

// 2. Check form state
const formData = await execute_js({
    script: `
        const form = document.querySelector('form');
        const formData = new FormData(form);
        const obj = {};
        formData.forEach((value, key) => obj[key] = value);
        JSON.stringify({
            action: form.action,
            method: form.method,
            data: obj
        });
    `
});

// 3. Check for validation errors
const logs = await get_console_logs({ level: "error" });

// 4. Check network-related errors (if applicable)
const exceptions = await get_exceptions({});
```

#### Pattern 2: Debugging State Management Issues

```typescript
// 1. Inspect current state
const currentState = await execute_js({
    script: "JSON.stringify(window.store?.getState() || {})"
});

// 2. Check localStorage for persisted state
const persistedState = await local_storage_get({ key: "redux_state" });

// 3. Compare expected vs actual
// 4. Check for state update errors in logs
const logs = await get_console_logs({ level: "warn" });
```

#### Pattern 3: Debugging Visual Rendering Issues

```typescript
// 1. Take screenshot
const screenshot = await take_screenshot({});

// 2. Get DOM to check element attributes
const dom = await get_dom({});

// 3. Check element positioning
const position = await get_element_position({
    selector: ".problematic-element"
});

// 4. Check computed styles
const styles = await execute_js({
    script: `
        const el = document.querySelector('.problematic-element');
        const styles = window.getComputedStyle(el);
        JSON.stringify({
            display: styles.display,
            visibility: styles.visibility,
            opacity: styles.opacity,
            position: styles.position,
            zIndex: styles.zIndex
        });
    `
});
```

#### Pattern 4: Debugging API Integration Issues

```typescript
// 1. Check for network errors in console
const logs = await get_console_logs({ level: "error" });

// 2. Check application state for API responses
const apiState = await execute_js({
    script: `
        JSON.stringify({
            baseURL: window.API_BASE_URL,
            lastResponse: window.__lastAPIResponse__,
            pendingRequests: window.__pendingRequests__?.length || 0
        });
    `
});

// 3. Check localStorage for tokens
const authToken = await local_storage_get({ key: "auth_token" });

// 4. Verify token format and expiration
const tokenInfo = await execute_js({
    script: `
        try {
            const token = localStorage.getItem('auth_token');
            if (!token) throw new Error('No token');
            const parts = token.split('.');
            const payload = JSON.parse(atob(parts[1]));
            JSON.stringify({
                isExpired: payload.exp * 1000 < Date.now(),
                expiresAt: new Date(payload.exp * 1000).toISOString()
            });
        } catch (e) {
            JSON.stringify({ error: e.message });
        }
    `
});
```

### Error Handling for AI Agents

When tool calls fail, handle errors systematically:

```typescript
try {
    const result = await some_tool({ params });
} catch (error) {
    // 1. Check if it's a connectivity issue
    try {
        await ping({});
    } catch (pingError) {
        // Plugin is not accessible - inform user
        // Suggest: Check if Tauri app is running
        // Suggest: Verify socket configuration
        return;
    }

    // 2. Check if it's a parameter validation issue
    if (error.message.includes('validation')) {
        // Review parameter types in Tool Parameters Reference
        // Provide corrected parameters
    }

    // 3. Check if it's a window-specific issue
    if (error.message.includes('window')) {
        // Verify window_label is correct
        // Check if window still exists
    }

    // 4. Provide helpful context to user
    // Include: What you were trying to do
    // Include: The specific error message
    // Include: Suggested next steps
}
```

### Performance Tips

1. **Batch JavaScript execution:**
   ```typescript
   // Good: Single execution
   const allData = await execute_js({
       script: `
           JSON.stringify({
               title: document.title,
               url: location.href,
               userCount: document.querySelectorAll('.user').length,
               isLoggedIn: !!localStorage.getItem('auth_token')
           });
       `
   });

   // Bad: Multiple round trips
   const title = await execute_js({ script: "document.title" });
   const url = await execute_js({ script: "location.href" });
   const userCount = await execute_js({ script: "document.querySelectorAll('.user').length" });
   ```

2. **Use appropriate screenshot quality:**
   - Use `quality: 60-70` for quick checks
   - Use `quality: 90-100` for detailed analysis
   - Lower quality = faster transfer, smaller size

3. **Limit log retrieval:**
   - Use `limit` parameter to avoid retrieving thousands of logs
   - Use `since` parameter to get recent logs only
   - Filter by `level` to focus on errors

4. **Cache DOM if analyzing multiple times:**
   - Get DOM once and analyze it multiple times in your code
   - Only fetch again if you've made changes to the app

## Usage Examples

### Example 1: Visual Regression Testing

Have AI agents automatically detect UI changes:

**Prompt to AI:**
> "Take a screenshot of the main window, then click the 'Theme' button and take another screenshot. Compare the two and tell me what changed visually."

**What happens:**
1. AI takes initial screenshot
2. AI simulates mouse click on theme button
3. AI takes second screenshot
4. AI analyzes both images and reports differences (colors, layout, etc.)

### Example 2: Automated Form Testing

Test form validation and submission:

**Prompt to AI:**
> "Fill out the registration form with invalid data and verify the error messages are displayed correctly."

**What happens:**
1. AI uses `text_input` to type into form fields
2. AI uses `mouse_movement` to click submit button
3. AI uses `take_screenshot` to capture error state
4. AI uses `get_dom` to verify error messages in DOM
5. AI reports whether validation works correctly

### Example 3: State Inspection

Debug application state without opening DevTools:

**Prompt to AI:**
> "Check the current Redux store state and tell me if the user is authenticated."

**What happens:**
1. AI uses `execute_js` to run: `window.store.getState()`
2. AI examines the returned state object
3. AI reports authentication status and related data

### Example 4: Multi-Window Testing

Test multi-window scenarios:

**Prompt to AI:**
> "Open the settings window, change the theme to dark, take a screenshot, then switch back to the main window and verify the theme changed there too."

**What happens:**
1. AI uses `window_manager` to focus settings window
2. AI interacts with theme controls
3. AI takes screenshot of settings window
4. AI switches to main window using `window_manager`
5. AI verifies theme consistency across windows

### Example 5: localStorage Debugging

Inspect and modify stored data:

**Prompt to AI:**
> "Check what's stored in localStorage and clear any expired session tokens."

**What happens:**
1. AI uses `local_storage_get_all` to retrieve all entries
2. AI examines token expiration dates
3. AI uses `local_storage_remove` to clear expired tokens
4. AI confirms cleanup was successful

## Security Considerations

### Development-Only Usage

**CRITICAL:** This plugin provides powerful access to your application and should **NEVER** be included in production builds.

Always wrap plugin registration in debug assertions:

```rust
#[cfg(debug_assertions)]
{
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(...));
}
```

### Why This Matters

The plugin allows:
- **Arbitrary JavaScript execution** in your webview
- **Full DOM access** including sensitive data
- **Screenshot capture** of potentially sensitive UI
- **Storage access** including tokens and credentials
- **Input simulation** that could trigger unintended actions

### Production Build Protection

Verify the plugin is excluded from production:

```bash
# Build for production
pnpm run tauri build

# Check the binary doesn't include MCP symbols (Linux/macOS)
nm -a ./target/release/myapp | grep -i mcp
# Should return nothing if properly excluded

# Or check Cargo features
cargo tree --features | grep mcp
```

### Network Security (TCP Mode)

When using TCP mode:

1. **Bind to localhost only**: Never use `0.0.0.0`
   ```rust
   .tcp("127.0.0.1".to_string(), 4000)  // Safe
   .tcp("0.0.0.0".to_string(), 4000)    // DANGEROUS
   ```

2. **Firewall protection**: Ensure firewall blocks external access to MCP port
   ```bash
   # macOS - block external access
   sudo pfctl -e
   ```

3. **Use IPC instead**: Prefer IPC sockets which can't be accessed remotely

### Data Exposure Risks

Be aware that AI agents can access:
- **User credentials** in localStorage/sessionStorage
- **API tokens** in application state
- **Personal data** displayed in the UI
- **Business logic** via JavaScript execution

**Mitigation:**
- Use the plugin only with trusted AI agents
- Review AI agent prompts before execution
- Clear sensitive data from development environments
- Use test accounts, not production credentials

## Advanced Topics

### Extending the Plugin

Add custom tools for your specific needs:

#### 1. Create Rust Tool Handler

Create `src/tools/custom_tool.rs`:

```rust
use tauri::{AppHandle, Runtime};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct CustomToolParams {
    pub param1: String,
}

#[derive(Serialize)]
pub struct CustomToolResult {
    pub result: String,
}

pub async fn custom_tool<R: Runtime>(
    app: &AppHandle<R>,
    params: CustomToolParams,
) -> Result<CustomToolResult, String> {
    // Your custom logic here
    Ok(CustomToolResult {
        result: format!("Processed: {}", params.param1),
    })
}
```

#### 2. Register in Router

In `src/tools/mod.rs`:

```rust
pub mod custom_tool;

// In the command router
match action {
    "custom_tool" => {
        let params = serde_json::from_value(command.params)?;
        let result = custom_tool::custom_tool(&app, params).await?;
        Ok(json!({ "success": true, "data": result }))
    }
    // ... other actions
}
```

#### 3. Add TypeScript Binding

In `mcp-server-ts/src/tools/custom_tool.ts`:

```typescript
export const customToolDefinition = {
    name: "custom_tool",
    description: "Your custom tool description",
    inputSchema: {
        type: "object",
        properties: {
            param1: {
                type: "string",
                description: "Parameter description"
            }
        },
        required: ["param1"]
    }
};

export async function customTool(params: { param1: string }) {
    return await client.sendCommand("custom_tool", params);
}
```

#### 4. Register in MCP Server

In `mcp-server-ts/src/tools/index.ts`:

```typescript
import { customToolDefinition, customTool } from './custom_tool';

server.registerTool(customToolDefinition, customTool);
```

### Performance Optimization

#### Screenshot Compression

Reduce screenshot size for faster transmission:

```rust
PluginConfig::new("App".to_string())
    .screenshot_quality(60)  // Lower quality = smaller size
```

#### Connection Pooling

The plugin supports persistent connections. Ensure your client reuses connections:

```typescript
// Good: Reuse connection
const client = await createClient();
await client.sendCommand("ping", {});
await client.sendCommand("take_screenshot", {});

// Bad: New connection each time
await (await createClient()).sendCommand("ping", {});
await (await createClient()).sendCommand("take_screenshot", {});
```

#### Batch Operations

When possible, batch operations into single JavaScript executions:

```typescript
// Good: Single JS execution
execute_js({
    script: `
        const data = {
            title: document.title,
            url: window.location.href,
            userCount: document.querySelectorAll('.user').length
        };
        JSON.stringify(data);
    `
});

// Bad: Multiple roundtrips
execute_js({ script: "document.title" });
execute_js({ script: "window.location.href" });
execute_js({ script: "document.querySelectorAll('.user').length" });
```

### Cross-Platform Considerations

#### Window Name Matching

Different platforms may report window titles differently:

```rust
// macOS: Usually exact match
PluginConfig::new("MyApp".to_string())

// Windows: May include additional decorations
PluginConfig::new("MyApp - Window Name".to_string())

// Linux: Depends on window manager
// Test with: wmctrl -l
```

#### Socket Paths

Platform-specific default paths:

```rust
#[cfg(target_os = "macos")]
const DEFAULT_SOCKET: &str = "/tmp/tauri-mcp.sock";

#[cfg(target_os = "linux")]
const DEFAULT_SOCKET: &str = "/tmp/tauri-mcp.sock";

#[cfg(target_os = "windows")]
const DEFAULT_SOCKET: &str = "\\\\.\\pipe\\tauri-mcp";
```

#### Permission Differences

- **macOS**: Requires Screen Recording permission for screenshots
- **Windows**: May need admin rights for certain window operations
- **Linux**: Depends on X11/Wayland and window manager permissions

## Contributing

Contributions are welcome! Here's how to get started:

### Development Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/tauri-plugin-mcp
cd tauri-plugin-mcp

# Install dependencies
pnpm install

# Build plugin and server
pnpm run build && pnpm run build-plugin

# Run tests
cargo test
cd mcp-server-ts && pnpm test
```

### Development Workflow

#### 1. Setting Up Your Development Environment

**Required Tools:**
- Rust toolchain (latest stable)
- Node.js 18+ and pnpm
- A Tauri test application
- MCP Inspector for testing: `npx @modelcontextprotocol/inspector`

**IDE Setup (Recommended):**
- **VS Code** with extensions:
  - rust-analyzer
  - Tauri
  - ESLint
  - Prettier
- **IntelliJ IDEA/RustRover** with Rust and Tauri plugins

#### 2. Making Changes

**For Rust Changes (Plugin Core):**

```bash
# 1. Make changes in src/
vim src/tools/my_tool.rs

# 2. Run format and lint
cargo fmt
cargo clippy

# 3. Build
cargo build

# 4. Test
cargo test

# 5. Test in real app
cd ../your-tauri-app
pnpm run tauri dev
```

**For TypeScript Changes (MCP Server):**

```bash
cd mcp-server-ts

# 1. Make changes in src/
vim src/tools/my_tool.ts

# 2. Run format and lint
pnpm run lint
pnpm run format

# 3. Build
pnpm build

# 4. Test
pnpm test

# 5. Test with MCP Inspector
npx @modelcontextprotocol/inspector node build/index.js
```

#### 3. Testing Your Changes

**Unit Tests:**
```bash
# Rust unit tests
cargo test

# TypeScript unit tests
cd mcp-server-ts && pnpm test
```

**Integration Testing:**

1. Start your Tauri test app with the plugin:
   ```bash
   cd your-test-app
   pnpm run tauri dev
   ```

2. Use MCP Inspector to test tools:
   ```bash
   cd mcp-server-ts
   npx @modelcontextprotocol/inspector node build/index.js
   ```

3. Or test with your AI agent (Claude Code, Cursor, Cline)

**Manual Socket Testing:**
```bash
# Test ping command
echo '{"action":"ping","params":{}}' | nc -U /tmp/tauri-mcp.sock

# Test health check
echo '{"action":"health_check","params":{}}' | nc -U /tmp/tauri-mcp.sock
```

#### 4. Debugging

**Rust Debugging:**

Enable verbose logging in your test app:
```rust
#[cfg(debug_assertions)]
{
    env_logger::init();  // Add this
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(...));
}
```

Then run with:
```bash
RUST_LOG=debug pnpm run tauri dev
```

**TypeScript Debugging:**

Add debug logging in `mcp-server-ts/src/client.ts`:
```typescript
console.error('[MCP] Sending command:', command);
console.error('[MCP] Received response:', response);
```

Run with Node debugging:
```bash
node --inspect build/index.js
```

#### 5. Pre-Commit Checklist

- [ ] Code formatted (`cargo fmt`, `pnpm run format`)
- [ ] Lints pass (`cargo clippy`, `pnpm run lint`)
- [ ] Tests pass (`cargo test`, `pnpm test`)
- [ ] Changes tested in real Tauri app
- [ ] Documentation updated (README, doc comments)
- [ ] CHANGELOG.md updated (if applicable)

### Adding New Tools

Complete workflow for adding a new MCP tool:

#### Step 1: Plan the Tool

Define:
- **Purpose**: What problem does it solve?
- **Parameters**: What inputs does it need?
- **Return Type**: What data does it return?
- **Use Case**: When would AI agents use it?

Example:
```
Tool: get_network_requests
Purpose: Retrieve all network requests made by the app
Parameters: { since?: timestamp, filter?: regex }
Returns: Array of { url, method, status, headers, body, timing }
Use Case: Debugging API integration issues, analyzing performance
```

#### Step 2: Implement Rust Handler

Create `src/tools/my_tool.rs`:

```rust
use tauri::{AppHandle, Runtime};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct MyToolParams {
    pub param1: String,
    pub optional_param: Option<i32>,
}

#[derive(Serialize)]
pub struct MyToolResult {
    pub data: String,
}

pub async fn my_tool<R: Runtime>(
    app: &AppHandle<R>,
    params: MyToolParams,
) -> Result<MyToolResult, String> {
    // Implementation here
    Ok(MyToolResult {
        data: format!("Processed: {}", params.param1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_my_tool() {
        // Add unit tests
    }
}
```

#### Step 3: Register in Router

Add to `src/tools/mod.rs`:

```rust
pub mod my_tool;

// In the command router match statement
"my_tool" => {
    let params = serde_json::from_value(command.params)?;
    let result = my_tool::my_tool(&app, params).await?;
    Ok(json!({ "success": true, "data": result }))
}
```

#### Step 4: Add TypeScript Binding

Create `mcp-server-ts/src/tools/my_tool.ts`:

```typescript
import { client } from './client';

export const myToolDefinition = {
    name: "my_tool",
    description: "Clear description of what the tool does",
    inputSchema: {
        type: "object",
        properties: {
            param1: {
                type: "string",
                description: "Parameter description"
            },
            optional_param: {
                type: "number",
                description: "Optional parameter"
            }
        },
        required: ["param1"]
    }
};

export async function myTool(params: {
    param1: string;
    optional_param?: number;
}) {
    return await client.sendCommand("my_tool", params);
}
```

#### Step 5: Register in MCP Server

Add to `mcp-server-ts/src/tools/index.ts`:

```typescript
import { myToolDefinition, myTool } from './my_tool';

// In the setup function
server.registerTool(myToolDefinition, myTool);
```

#### Step 6: Write Tests

**Rust test:**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_my_tool_success() {
        // Test implementation
    }

    #[tokio::test]
    async fn test_my_tool_validation() {
        // Test error cases
    }
}
```

**TypeScript test:**
```typescript
// mcp-server-ts/tests/my_tool.test.ts
import { myTool } from '../src/tools/my_tool';

describe('myTool', () => {
    it('should process valid input', async () => {
        // Test implementation
    });
});
```

#### Step 7: Update Documentation

Add to README:
1. Add entry in Quick Reference table
2. Add to Tool Parameters Reference
3. Add example usage in Usage Examples section

### Code Style

- **Rust**: Follow `rustfmt` and `clippy` suggestions
  - Run: `cargo fmt && cargo clippy`
  - Fix all clippy warnings before committing
- **TypeScript**: Use ESLint and Prettier configurations
  - Run: `pnpm run lint && pnpm run format`
- **Commits**: Use conventional commit format
  - `feat:` for new features
  - `fix:` for bug fixes
  - `docs:` for documentation
  - `refactor:` for code refactoring
  - `test:` for adding tests

### Testing

```bash
# Rust tests
cargo test

# TypeScript tests
cd mcp-server-ts
pnpm test

# Integration tests with MCP Inspector
cd mcp-server-ts
npx @modelcontextprotocol/inspector node build/index.js

# Integration tests with real app
cd examples/test-app
pnpm run tauri dev
# Then test with your AI agent
```

### Common Development Tasks

**Rebuilding after changes:**
```bash
# Full rebuild
pnpm run build && pnpm run build-plugin

# Rust only
cargo build

# TypeScript only
cd mcp-server-ts && pnpm build
```

**Running with verbose logging:**
```bash
# Tauri app with debug logs
RUST_LOG=debug pnpm run tauri dev

# MCP server with debug logs
DEBUG=* node build/index.js
```

**Testing socket connectivity:**
```bash
# Check if socket exists
ls -l /tmp/tauri-mcp.sock

# Test with netcat
echo '{"action":"ping","params":{}}' | nc -U /tmp/tauri-mcp.sock
```

## License

[Specify your license here - e.g., MIT, Apache 2.0, etc.]

## Acknowledgments

- Built on [Tauri](https://tauri.app) - Secure desktop application framework
- Implements [Model Context Protocol](https://modelcontextprotocol.io) - Standard for AI-application integration
- Inspired by browser automation tools like Selenium and Playwright

## Resources

### Documentation

- **[Quick Start Guide](docs/QUICK_START.md)** - Get up and running in 15 minutes
- **[Integration Guide](docs/INTEGRATION_GUIDE.md)** - Comprehensive setup and troubleshooting
- **[Testing Guide](docs/TESTING_GUIDE.md)** - AI-powered testing scenarios and patterns
- **[Documentation Hub](docs/README.md)** - Complete documentation overview

### External Links

- **Tauri Documentation**: https://tauri.app/v2/
- **MCP Specification**: https://spec.modelcontextprotocol.io/
- **Original Plugin**: https://github.com/P3GLEG/tauri-plugin-mcp
- **Claude Code**: https://claude.com/claude-code

### Community

- **Issue Tracker**: [GitHub Issues](https://github.com/yourusername/tauri-plugin-mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/tauri-plugin-mcp/discussions)
- **Tauri Discord**: https://discord.gg/tauri
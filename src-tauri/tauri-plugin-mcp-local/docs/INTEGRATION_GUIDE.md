# Integration Guide - Tauri MCP Plugin

This comprehensive guide covers everything you need to integrate the Tauri MCP plugin into your Tauri v2 application.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation Steps](#installation-steps)
- [Configuration Options](#configuration-options)
- [Platform-Specific Setup](#platform-specific-setup)
- [Troubleshooting](#troubleshooting)
- [Advanced Configuration](#advanced-configuration)
- [Best Practices](#best-practices)

## Prerequisites

Before integrating the MCP plugin, ensure you have:

- **Tauri v2** application (not v1)
- **Rust** toolchain (latest stable)
- **Node.js** 18+ and pnpm (or npm/yarn)
- **Tauri CLI v2**: `cargo install tauri-cli --version "^2.0.0"`
- **Claude Code, Cursor, or Cline** (MCP-compatible AI agent)

## Installation Steps

### Step 1: Clone and Build the Plugin

From your Tauri project root:

```bash
# Clone the plugin repository
git clone https://github.com/yourusername/tauri-plugin-mcp .tauri-plugin-mcp

# Optional: Add to .gitignore if you don't want to commit it
echo ".tauri-plugin-mcp/" >> .gitignore

# Install and build
cd .tauri-plugin-mcp
pnpm install
pnpm run build
pnpm run build-plugin

# Build the TypeScript MCP server
cd mcp-server-ts
pnpm install
pnpm build
cd ../..
```

Verify the build:
```bash
# Check Rust plugin was compiled
ls -la .tauri-plugin-mcp/target/release/

# Check TypeScript server was built
ls -la .tauri-plugin-mcp/mcp-server-ts/build/index.js
```

### Step 2: Add Rust Dependency

Edit `src-tauri/Cargo.toml`:

```toml
[dependencies]
# ... your existing dependencies ...
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# MCP plugin for debugging (dev only)
tauri-plugin-mcp = { path = "../.tauri-plugin-mcp", optional = true }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
mcp = ["dep:tauri-plugin-mcp"]  # Add this feature
```

**Important**: The `optional = true` ensures the plugin is only included when explicitly enabled.

### Step 3: Add TypeScript Dependency

Edit `package.json`:

```json
{
  "name": "your-app",
  "version": "1.0.0",
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "tauri-plugin-mcp": "file:./.tauri-plugin-mcp"
  },
  "scripts": {
    "dev": "vite",
    "dev:mcp": "cargo tauri dev --features mcp",
    "build": "vite build",
    "tauri": "tauri"
  }
}
```

Install dependencies:
```bash
pnpm install
```

### Step 4: Register Plugin in main.rs

There are two approaches for registering the plugin:

#### Approach A: Simple Registration (Recommended for Most Apps)

Edit `src-tauri/src/main.rs`:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Only enable MCP in development builds with feature flag
    #[cfg(all(debug_assertions, feature = "mcp"))]
    {
        use tauri_plugin_mcp::PluginConfig;

        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            PluginConfig::new("YourAppName".to_string())  // CHANGE THIS!
                .start_socket_server(true)
                .socket_path("/tmp/yourapp-mcp.sock".into())  // CHANGE THIS!
        ));

        log::info!("MCP plugin enabled for development");
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

#### Approach B: With Async Main (For Apps with Async Setup)

```rust
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut builder = tauri::Builder::default();

    // Only enable MCP in development builds
    #[cfg(all(debug_assertions, feature = "mcp"))]
    {
        use tauri_plugin_mcp::PluginConfig;

        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            PluginConfig::new("YourAppName".to_string())
                .start_socket_server(true)
                .socket_path("/tmp/yourapp-mcp.sock".into())
        ));

        log::info!("MCP plugin enabled for development");
    }

    builder
        .run(tauri::generate_context!())
        .map_err(|e| e.into())
}
```

**Critical Configuration:**

1. **App Name**: Replace `"YourAppName"` with your app's exact window title
   - Check `src-tauri/tauri.conf.json` → `"title"` field
   - Must match exactly (case-sensitive)

2. **Socket Path**: Replace `/tmp/yourapp-mcp.sock` with a unique path
   - Use your app's name to avoid conflicts
   - macOS/Linux: `/tmp/yourapp-mcp.sock`
   - Windows: `r"\\\\.\\pipe\\yourapp-mcp"` (see [Platform-Specific Setup](#platform-specific-setup))

### Step 5: Configure MCP Server

Create `.claude/mcp-config.json` in your project root (recommended for project-local configuration):

```json
{
  "mcpServers": {
    "yourapp-mcp": {
      "command": "node",
      "args": ["./.tauri-plugin-mcp/mcp-server-ts/build/index.js"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/tmp/yourapp-mcp.sock"
      }
    }
  }
}
```

**Or** add to Claude Code's global config (`~/.config/claude/claude_code_config.json`):

```json
{
  "mcpServers": {
    "yourapp-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/your-project/.tauri-plugin-mcp/mcp-server-ts/build/index.js"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/tmp/yourapp-mcp.sock"
      }
    }
  }
}
```

**Important**: The socket path must match what you set in `main.rs` Step 4.

### Step 6: Verify Integration

```bash
# Build and run with MCP feature
cargo tauri dev --features mcp

# Or use the script from package.json
pnpm run dev:mcp
```

**Check for success:**
1. App starts without errors
2. Console shows: `MCP plugin enabled for development`
3. Socket file appears: `ls -l /tmp/yourapp-mcp.sock`
4. Claude Code can connect: Ask "Use the ping tool"

## Configuration Options

### PluginConfig Options

```rust
PluginConfig::new("AppName".to_string())
    // Socket server configuration
    .start_socket_server(true)            // Enable socket server (required)

    // Connection mode 1: IPC Socket (default, recommended)
    .socket_path("/tmp/app-mcp.sock".into())

    // Connection mode 2: TCP (alternative)
    // .tcp("127.0.0.1".to_string(), 4000)
```

### IPC Socket Mode (Default - Recommended)

**Pros:**
- Fast, low overhead
- Secure (not network-accessible)
- Platform-specific optimization
- Works well for local development

**Cons:**
- Requires file system permissions
- Not accessible from Docker/remote

**Configuration:**
```rust
// Rust (main.rs)
.socket_path("/tmp/yourapp-mcp.sock".into())
```

```json
// MCP config
"env": {
  "TAURI_MCP_IPC_PATH": "/tmp/yourapp-mcp.sock"
}
```

### TCP Socket Mode (Alternative)

**Pros:**
- Works in Docker containers
- Enables remote debugging
- No file system permissions needed
- Works across network (if desired)

**Cons:**
- Slightly higher overhead
- Requires port management
- Security risk if exposed to network

**Configuration:**
```rust
// Rust (main.rs)
.tcp("127.0.0.1".to_string(), 4000)
```

```json
// MCP config
"env": {
  "TAURI_MCP_CONNECTION_TYPE": "tcp",
  "TAURI_MCP_TCP_HOST": "127.0.0.1",
  "TAURI_MCP_TCP_PORT": "4000"
}
```

**Security Note**: Always use `127.0.0.1` (localhost) for TCP mode. Never use `0.0.0.0` which exposes to the network.

## Platform-Specific Setup

### macOS

**Socket Path:**
```rust
.socket_path("/tmp/yourapp-mcp.sock".into())
```

**Screen Recording Permission:**
- Screenshots require Screen Recording permission
- System Preferences → Security & Privacy → Screen Recording
- Enable for Terminal (or your IDE)

**Verification:**
```bash
# Check socket exists
ls -l /tmp/yourapp-mcp.sock

# Test connection
echo '{"action":"ping","params":{}}' | nc -U /tmp/yourapp-mcp.sock
```

### Linux

**Socket Path:**
```rust
.socket_path("/tmp/yourapp-mcp.sock".into())
```

**Permissions:**
- Ensure `/tmp/` is writable
- Socket file permissions: `srwxr-xr-x`

**Verification:**
```bash
# Check socket
ls -l /tmp/yourapp-mcp.sock

# Test connection
echo '{"action":"ping","params":{}}' | nc -U /tmp/yourapp-mcp.sock

# Check permissions
stat /tmp/yourapp-mcp.sock
```

### Windows

**Named Pipe Path:**
```rust
.socket_path(r"\\\\.\\pipe\\yourapp-mcp".into())
```

**MCP Config:**
```json
"env": {
  "TAURI_MCP_IPC_PATH": "\\\\.\\pipe\\yourapp-mcp"
}
```

**Note**: The extra backslashes are required for JSON escaping.

**Verification:**
```powershell
# Check named pipe exists
Get-ChildItem \\.\pipe\ | Select-String yourapp-mcp

# Test connection (use named pipe utilities)
```

## Troubleshooting

### Issue 1: "Cannot start a runtime from within a runtime"

**Cause**: Code trying to create a new Tokio runtime while already inside one.

**Solution**: Use `Handle::current()` instead of `Runtime::new()`:

```rust
// ❌ WRONG
let rt = tokio::runtime::Runtime::new()?;
rt.block_on(async { ... });

// ✅ CORRECT
let handle = tokio::runtime::Handle::current();
handle.block_on(async { ... });
```

**Exception**: If you're in `setup()` before Tauri's runtime starts, you can use `Runtime::new()` in a separate thread:

```rust
let result = std::thread::spawn(move || {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async { /* your code */ })
}).join();
```

### Issue 2: "Socket address already in use"

**Cause**: Stale socket file from previous crashed run.

**Solution**: The plugin should auto-cleanup, but if not:

```bash
# Manual cleanup
rm -f /tmp/yourapp-mcp.sock

# Kill all instances
pkill -f "tauri dev"

# Restart
pnpm run dev:mcp
```

**Prevention**: Add to plugin initialization (if not already there):

```rust
// Clean stale sockets before starting
#[cfg(not(target_os = "windows"))]
if socket_path.exists() {
    log::warn!("Removing stale socket file: {:?}", socket_path);
    std::fs::remove_file(&socket_path)?;
}
```

### Issue 3: "MCP tools not available"

**Cause**: MCP server not connecting or not configured.

**Solution**:

1. Verify app is running: `pnpm run dev:mcp`
2. Check socket exists: `ls -l /tmp/yourapp-mcp.sock`
3. Rebuild MCP server:
   ```bash
   cd .tauri-plugin-mcp/mcp-server-ts
   pnpm build
   ```
4. Reload Claude Code MCP configuration
5. Check Claude Code console for connection errors

### Issue 4: "Screenshot is black/empty"

**Cause**: Window name mismatch or permissions.

**Solution**:

1. Verify window title matches:
   ```rust
   // In main.rs - must match exactly
   PluginConfig::new("MyApp".to_string())
   ```
   ```json
   // In tauri.conf.json
   "title": "MyApp"
   ```

2. On macOS: Grant Screen Recording permission
3. Ensure window is visible (not minimized)
4. Wait for app to fully load before taking screenshots

### Issue 5: "Permission denied" (IPC mode)

**Cause**: File system permissions on socket path.

**Solution**:

1. Check directory is writable:
   ```bash
   touch /tmp/test && rm /tmp/test
   ```

2. Use different path:
   ```rust
   .socket_path("/Users/yourusername/.yourapp-mcp.sock".into())
   ```

3. Or switch to TCP mode:
   ```rust
   .tcp("127.0.0.1".to_string(), 4000)
   ```

### Issue 6: "Connection refused"

**Cause**: App not running or socket server not started.

**Solution**:

1. Verify app is running with MCP feature:
   ```bash
   cargo tauri dev --features mcp
   ```

2. Check logs for "MCP plugin enabled"

3. Verify socket/port is listening:
   ```bash
   # IPC
   ls -l /tmp/yourapp-mcp.sock

   # TCP
   lsof -i :4000  # macOS/Linux
   netstat -an | findstr :4000  # Windows
   ```

4. Restart both app and Claude Code

### Issue 7: "Empty Icon Files Causing Panic"

**Cause**: Icon files are 0 bytes.

**Solution**:

```bash
# Generate icons properly
cargo tauri icon path/to/your-icon.png

# Or copy valid icon
cp src-tauri/icons/128x128.png src-tauri/icons/128x128@2x.png
```

## Advanced Configuration

### Custom Socket Paths

For multi-project setups or special requirements:

```rust
// Development vs production paths
#[cfg(debug_assertions)]
let socket_path = "/tmp/yourapp-dev-mcp.sock";

#[cfg(not(debug_assertions))]
let socket_path = "/var/run/yourapp-mcp.sock";

builder = builder.plugin(tauri_plugin_mcp::init_with_config(
    PluginConfig::new("YourApp".to_string())
        .start_socket_server(true)
        .socket_path(socket_path.into())
));
```

### Environment-Based Configuration

```rust
// Read from environment variable
let socket_path = std::env::var("MCP_SOCKET_PATH")
    .unwrap_or_else(|_| "/tmp/yourapp-mcp.sock".to_string());

let use_tcp = std::env::var("MCP_USE_TCP").is_ok();

if use_tcp {
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        PluginConfig::new("YourApp".to_string())
            .tcp("127.0.0.1".to_string(), 4000)
    ));
} else {
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        PluginConfig::new("YourApp".to_string())
            .socket_path(socket_path.into())
    ));
}
```

### Conditional Compilation

Fine-grained control over when MCP is available:

```rust
// Only on specific platforms
#[cfg(all(
    debug_assertions,
    feature = "mcp",
    any(target_os = "macos", target_os = "linux")
))]
{
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(...));
}

// Only in specific build profiles
#[cfg(all(debug_assertions, feature = "mcp", not(feature = "release")))]
{
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(...));
}
```

### Multiple MCP Instances

For apps with multiple windows that need separate MCP servers:

```rust
#[cfg(all(debug_assertions, feature = "mcp"))]
{
    // Main window MCP
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        PluginConfig::new("MainWindow".to_string())
            .socket_path("/tmp/app-main-mcp.sock".into())
    ));

    // Settings window MCP
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        PluginConfig::new("SettingsWindow".to_string())
            .socket_path("/tmp/app-settings-mcp.sock".into())
    ));
}
```

Configure both in MCP config:

```json
{
  "mcpServers": {
    "app-main": {
      "command": "node",
      "args": ["./.tauri-plugin-mcp/mcp-server-ts/build/index.js"],
      "env": { "TAURI_MCP_IPC_PATH": "/tmp/app-main-mcp.sock" }
    },
    "app-settings": {
      "command": "node",
      "args": ["./.tauri-plugin-mcp/mcp-server-ts/build/index.js"],
      "env": { "TAURI_MCP_IPC_PATH": "/tmp/app-settings-mcp.sock" }
    }
  }
}
```

## Best Practices

### 1. Feature Flag Hygiene

Always use both conditions:

```rust
#[cfg(all(debug_assertions, feature = "mcp"))]
{
    // MCP code here
}
```

This ensures:
- Never in release builds (`debug_assertions`)
- Only when explicitly enabled (`feature = "mcp"`)

### 2. Socket Naming Convention

Use descriptive, unique names:

```rust
// ❌ BAD - Generic, conflicts with other apps
.socket_path("/tmp/mcp.sock")

// ✅ GOOD - App-specific
.socket_path("/tmp/myapp-mcp.sock")

// ✅ BETTER - Environment-aware
.socket_path("/tmp/myapp-dev-mcp.sock")
```

### 3. Error Handling

Never panic in MCP-enabled code:

```rust
#[cfg(all(debug_assertions, feature = "mcp"))]
{
    match tauri_plugin_mcp::init_with_config(...) {
        Ok(plugin) => { builder = builder.plugin(plugin); }
        Err(e) => {
            log::error!("Failed to initialize MCP: {}", e);
            // App continues without MCP
        }
    }
}
```

### 4. Documentation

Document MCP usage in your project:

```markdown
## Development with MCP

Start the app with MCP debugging:
```bash
pnpm run dev:mcp
```

This enables AI-assisted testing and debugging.
See `.tauri-plugin-mcp/docs/` for more information.
```

### 5. Testing Before Release

Verify MCP is excluded from production:

```bash
# Build production
cargo tauri build

# Verify no MCP symbols (macOS/Linux)
nm -a ./target/release/yourapp | grep -i mcp
# Should return nothing

# Or check dependencies
cargo tree --features
# Should not include tauri-plugin-mcp
```

### 6. CI/CD Integration

Add MCP testing to your CI pipeline:

```yaml
# .github/workflows/test.yml
name: Integration Tests

on: [push, pull_request]

jobs:
  mcp-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - uses: dtolnay/rust-toolchain@stable

      - name: Install Tauri CLI
        run: cargo install tauri-cli --version "^2.0.0"

      - name: Install dependencies
        run: pnpm install

      - name: Build MCP plugin
        run: |
          cd .tauri-plugin-mcp
          pnpm install && pnpm run build && pnpm run build-plugin

      - name: Start app with MCP
        run: pnpm run dev:mcp &

      - name: Wait for socket
        run: timeout 30 bash -c 'until [ -S /tmp/yourapp-mcp.sock ]; do sleep 1; done'

      - name: Run basic connectivity test
        run: echo '{"action":"ping","params":{}}' | nc -U /tmp/yourapp-mcp.sock
```

## Next Steps

1. **Test the integration**: Follow [QUICK_START.md](QUICK_START.md) to verify everything works
2. **Learn the tools**: Review the [Tool Parameters Reference](../README.md#tool-parameters-reference)
3. **Create tests**: See [TESTING_GUIDE.md](TESTING_GUIDE.md) for test scenarios
4. **Read best practices**: See [AI Agent Usage Guide](../README.md#ai-agent-usage-guide)

## Resources

- [Quick Start Guide](QUICK_START.md)
- [Testing Guide](TESTING_GUIDE.md)
- [Main README](../README.md)
- [Tauri v2 Documentation](https://v2.tauri.app/)
- [MCP Specification](https://modelcontextprotocol.io/)

Happy integrating! 🚀

# Tauri MCP Plugin - Quick Start

Use AI to test your Tauri application automatically! 🤖

## What You'll Get

Once set up, you can ask AI agents like Claude Code to:
- Take screenshots and analyze your UI
- Click buttons and fill forms automatically
- Inspect DOM structure and application state
- Debug errors by examining console logs
- Test multi-step workflows without writing test code

## Prerequisites

- Tauri v2 application (already set up)
- Node.js 18+ and pnpm
- Claude Code, Cursor, or another MCP-compatible AI agent

## Installation

### Step 1: Add the Plugin to Your Project

```bash
# From your Tauri project root
cd /path/to/your-tauri-app

# Clone the plugin
git clone https://github.com/yourusername/tauri-plugin-mcp .tauri-plugin-mcp

# Build it
cd .tauri-plugin-mcp
pnpm install
pnpm run build && pnpm run build-plugin

# Build the MCP server
cd mcp-server-ts
pnpm install
pnpm build
cd ../..
```

### Step 2: Configure Your Tauri App

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
# ... your existing dependencies ...
tauri-plugin-mcp = { path = "../.tauri-plugin-mcp", optional = true }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
mcp = ["dep:tauri-plugin-mcp"]  # Add this feature
```

Add to `package.json`:

```json
{
  "dependencies": {
    "tauri-plugin-mcp": "file:./.tauri-plugin-mcp"
  }
}
```

Then run:
```bash
pnpm install
```

### Step 3: Register the Plugin

In `src-tauri/src/main.rs`:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Only enable MCP in development builds
    #[cfg(all(debug_assertions, feature = "mcp"))]
    {
        use tauri_plugin_mcp::PluginConfig;

        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            PluginConfig::new("YourAppName".to_string())  // Match your app's window title
                .start_socket_server(true)
                .socket_path("/tmp/yourapp-mcp.sock".into())  // Unix socket path
        ));

        log::info!("MCP plugin enabled for UI testing");
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Important**:
- Replace `"YourAppName"` with your app's exact window title
- Replace `/tmp/yourapp-mcp.sock` with a unique path for your app
- On Windows, use: `r"\\\\.\\pipe\\yourapp-mcp"` instead

### Step 4: Configure Your AI Agent

Create `.claude/mcp-config.json` in your project root:

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

**Or** add directly to Claude Code's global config (`~/.config/claude/claude_code_config.json`):

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

### Step 5: Add Convenience Script (Optional)

Add to your `package.json`:

```json
{
  "scripts": {
    "dev": "vite",
    "dev:mcp": "cargo tauri dev --features mcp",
    "tauri": "tauri"
  }
}
```

## Test It!

### 1. Start Your App with MCP Enabled

```bash
pnpm run dev:mcp
# or
cargo tauri dev --features mcp
```

Look for the log: `MCP plugin enabled for UI testing`

### 2. Verify Connection

In Claude Code (or your AI agent), ask:

> "Use the ping tool to verify connection to the app"

Expected response: Connection successful with pong response.

### 3. Run Your First Test

Try one of these prompts:

**Take a screenshot:**
> "Take a screenshot of the main window"

**Inspect the UI:**
> "Get the DOM and tell me what's on the screen"

**Debug a workflow:**
> "Click the 'New Item' button, fill in the form with test data, submit it, and verify the item appears in the list. Take screenshots at each step."

## What Can You Test?

### Visual Testing
- Screenshot before/after changes for regression testing
- Verify UI elements are rendered correctly
- Check theme switching (dark/light mode)
- Validate responsive layouts

### Interaction Testing
- Form submission and validation
- Button clicks and navigation
- Multi-step workflows
- Drag-and-drop functionality

### State Testing
- localStorage/sessionStorage inspection
- Application state verification
- Data persistence checks
- Authentication state validation

### Error Testing
- Console error detection
- Exception tracking
- API failure handling
- Edge case validation

## Example Test Scenarios

### Test 1: Form Validation

> "Test the login form:
> 1. Take a screenshot
> 2. Try submitting with empty fields - verify error messages
> 3. Try invalid email - verify error message
> 4. Try valid credentials - verify success
> 5. Screenshot each state"

### Test 2: Multi-Step Workflow

> "Test the complete checkout flow:
> 1. Add item to cart
> 2. Go to checkout
> 3. Fill in shipping information
> 4. Verify order summary
> 5. Take screenshots at each step
> 6. Check localStorage for cart persistence"

### Test 3: State Inspection

> "Inspect the application state:
> 1. Execute JavaScript to get window.store.getState()
> 2. Check localStorage for auth token
> 3. Verify user is logged in
> 4. Report any state inconsistencies"

## Troubleshooting

### "Connection refused"

**Check:**
1. App is running: `pnpm run dev:mcp`
2. Socket file exists: `ls -l /tmp/yourapp-mcp.sock`
3. Look for "MCP plugin enabled" in app logs

**Fix:**
```bash
# Restart the app
pkill -f "tauri dev"
pnpm run dev:mcp
```

### "Screenshot is black/empty"

**Check:**
1. Window title in `PluginConfig::new("...")` matches `tauri.conf.json`
2. Window is visible (not minimized)
3. On macOS: Grant Screen Recording permission to Terminal

### "Can't find the tool"

**Fix:**
```bash
# Rebuild MCP server
cd .tauri-plugin-mcp/mcp-server-ts
pnpm build
```

### "Socket already in use"

**Fix:**
```bash
# Remove stale socket
rm -f /tmp/yourapp-mcp.sock

# Or kill all instances
pkill -f "tauri dev"
```

## Production Builds

The MCP plugin is **automatically excluded** from production builds:
- Protected by `#[cfg(all(debug_assertions, feature = "mcp"))]`
- Only active when built with `--features mcp`
- Zero overhead in release builds

To verify:
```bash
# Production - MCP disabled
cargo tauri build

# Development - MCP available
cargo tauri dev --features mcp
```

## Next Steps

1. **Read the Full Documentation**: See [README.md](../README.md) for complete tool reference
2. **Learn AI Agent Best Practices**: See [AI Agent Usage Guide](../README.md#ai-agent-usage-guide)
3. **Explore Test Patterns**: See [TESTING_GUIDE.md](TESTING_GUIDE.md) for comprehensive test scenarios
4. **Customize Configuration**: See [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) for advanced setup

## Quick Reference

### Available Tools

| Tool | Purpose |
|------|---------|
| `ping` | Test connection |
| `health_check` | Verify plugin status |
| `take_screenshot` | Capture window image |
| `get_dom` | Retrieve HTML structure |
| `execute_js` | Run JavaScript in app |
| `get_element_position` | Find element coordinates |
| `inject_console_capture` | Enable console log capture |
| `get_console_logs` | Retrieve console messages |
| `inject_error_tracker` | Enable error tracking |
| `get_exceptions` | Retrieve tracked errors |
| `local_storage_get/set/remove/clear` | Manage localStorage |
| `manage_window` | Control window properties |

See [Tool Parameters Reference](../README.md#tool-parameters-reference) for detailed parameter specs.

## Getting Help

- **Documentation**: [Full README](../README.md)
- **Issues**: Check the troubleshooting section above
- **Examples**: See [TESTING_GUIDE.md](TESTING_GUIDE.md) for real-world scenarios

Happy testing! 🚀

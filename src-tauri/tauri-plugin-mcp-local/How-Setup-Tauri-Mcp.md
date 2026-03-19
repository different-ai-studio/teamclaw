# How to Setup Tauri MCP Plugin - Lessons Learned

This guide documents the complete setup process for integrating the Tauri MCP plugin into a Tauri application, based on real implementation experience.

## Overview

The Tauri MCP (Model Context Protocol) plugin enables AI assistants like Claude Code to interact with your running Tauri application through:
- DOM manipulation
- JavaScript execution
- Screenshot capture
- Console log monitoring
- Window management
- And 15+ other powerful debugging tools

## Prerequisites

- Tauri v2 application
- Node.js 18+ with pnpm (or npm/yarn)
- Rust toolchain (latest stable)
- The tauri-plugin-mcp repository cloned or added as a submodule

## Step-by-Step Setup

### 1. Build the MCP Plugin Guest JavaScript Module

**Critical First Step:** The plugin's TypeScript code must be compiled before use.

```bash
cd .tauri-plugin-mcp
pnpm install
pnpm build
```

This creates the JavaScript module in `.tauri-plugin-mcp/dist-js/`:
- `index.js` (ESM)
- `index.cjs` (CommonJS)
- `index.d.ts` (TypeScript definitions)

**Verification:**
```bash
ls -la .tauri-plugin-mcp/dist-js/
# Should show: index.js, index.cjs, index.d.ts
```

### 2. Configure Rust Backend

**File:** `src-tauri/Cargo.toml`

```toml
[dependencies]
tauri = { version = "2.9", features = [] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# MCP plugin for debugging (dev only)
tauri-plugin-mcp = { path = "../.tauri-plugin-mcp", optional = true }

[features]
default = ["custom-protocol", "mcp"]
custom-protocol = ["tauri/custom-protocol"]
mcp = ["dep:tauri-plugin-mcp"]
```

**File:** `src-tauri/src/lib.rs`

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Only enable MCP in development builds with feature flag
    #[cfg(all(debug_assertions, feature = "mcp"))]
    {
        use tauri_plugin_mcp::PluginConfig;

        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            PluginConfig::new("Brainstormer".to_string())  // Your app name
                .start_socket_server(true)
                .socket_path("/tmp/brainstormer-mcp.sock".to_string().into()),  // Your socket path
        ));

        println!("MCP plugin enabled for development");
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 3. Add Frontend Dependency

**File:** `package.json`

```json
{
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "@tauri-apps/api": "^2.9.0",
    "tauri-plugin-mcp": "file:./.tauri-plugin-mcp"
  }
}
```

**Important:** Use `file:` protocol for local dependency linking.

### 4. Initialize Plugin Listeners in Frontend

**File:** `src/main.tsx`

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { setupPluginListeners } from "tauri-plugin-mcp";

// Initialize MCP plugin listeners for AI debugging
setupPluginListeners();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

**Critical:** `setupPluginListeners()` must be called before React initialization to enable communication between the MCP server and the webview.

### 5. Install Dependencies

```bash
# Force reinstall to ensure proper linking
pnpm install --force
```

**Why `--force`?** Ensures pnpm properly resolves and links the local `file:` dependency.

### 6. Configure MCP Server in Claude Code

**File:** `.mcp.json` (project root)

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "node",
      "args": ["./.tauri-plugin-mcp/mcp-server-ts/build/index.js"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/tmp/brainstormer-mcp.sock"
      }
    }
  }
}
```

**Important:** The socket path must match what you configured in `src-tauri/src/lib.rs`.

### 7. Build the MCP TypeScript Server

```bash
cd .tauri-plugin-mcp/mcp-server-ts
pnpm install
pnpm build
```

Verify:
```bash
ls -la .tauri-plugin-mcp/mcp-server-ts/build/index.js
```

### 8. Run the Application

```bash
# Option 1: Use Tauri CLI directly
./node_modules/.bin/tauri dev --features mcp

# Option 2: Add npm script to package.json
pnpm dev:mcp
```

**Add to `package.json` scripts:**
```json
{
  "scripts": {
    "dev": "vite",
    "dev:mcp": "tauri dev --features mcp",
    "build": "tsc && vite build"
  }
}
```

## Verification

### 1. Check App Logs

You should see:
```
MCP plugin enabled for development
```

### 2. Verify Socket

```bash
ls -la /tmp/brainstormer-mcp.sock
# Should show: srwxr-xr-x ... /tmp/brainstormer-mcp.sock
```

### 3. Test MCP Connection (in Claude Code)

```typescript
// Health check
mcp__tauri-mcp__health_check()

// Take screenshot
mcp__tauri-mcp__take_screenshot({ window_label: "main" })

// Execute JavaScript
mcp__tauri-mcp__execute_js({
  code: "document.title",
  window_label: "main"
})
```

## Common Issues & Solutions

### Issue 1: "Failed to resolve import 'tauri-plugin-mcp'"

**Cause:** Guest-js module not built or dependencies not installed.

**Solution:**
```bash
cd .tauri-plugin-mcp
pnpm build
cd ..
pnpm install --force
```

### Issue 2: MCP Commands Timeout

**Cause:** Frontend listeners not initialized.

**Solution:** Ensure `setupPluginListeners()` is called in `src/main.tsx` **before** React initialization.

### Issue 3: Socket Connection Refused

**Cause:** App not running with MCP feature enabled.

**Solution:**
```bash
# Must use --features mcp flag
./node_modules/.bin/tauri dev --features mcp
```

### Issue 4: TypeScript Warnings During Build

**Cause:** Minor type issues in guest-js (safe to ignore).

**Solution:** These are warnings, not errors. The build will succeed and the plugin will work correctly.

### Issue 5: Vite Can't Find Plugin After Installation

**Cause:** Vite needs to restart to detect new dependencies.

**Solution:** Kill and restart the dev server after running `pnpm install`.

## Architecture Overview

```
┌─────────────────────────────────────────┐
│  Claude Code (AI Assistant)             │
└───────────────┬─────────────────────────┘
                │ MCP Protocol
┌───────────────▼─────────────────────────┐
│  MCP Server (TypeScript)                │
│  .tauri-plugin-mcp/mcp-server-ts/       │
└───────────────┬─────────────────────────┘
                │ Unix Socket
┌───────────────▼─────────────────────────┐
│  Tauri Backend (Rust)                   │
│  tauri-plugin-mcp                       │
└───────────────┬─────────────────────────┘
                │ Tauri IPC
┌───────────────▼─────────────────────────┐
│  Frontend (React + TypeScript)          │
│  setupPluginListeners()                 │
└─────────────────────────────────────────┘
```

## Available MCP Tools (20)

1. `take_screenshot` - Capture window screenshots
2. `get_dom` - Retrieve full DOM structure
3. `execute_js` - Execute JavaScript in webview
4. `get_element_position` - Find and click elements
5. `send_text_to_element` - Type into input fields
6. `simulate_mouse_movement` - Simulate mouse actions
7. `simulate_text_input` - Simulate keyboard input
8. `manage_window` - Control window state
9. `manage_local_storage` - Access localStorage
10. `inject_console_capture` - Enable console logging
11. `get_console_logs` - Retrieve console output
12. `inject_network_capture` - Enable network monitoring
13. `network_inspector` - Inspect HTTP requests
14. `inject_error_tracker` - Enable error tracking
15. `get_exceptions` - Retrieve runtime errors
16. `clear_exceptions` - Clear error log
17. `dump_application_state` - Inspect state (Zustand, Redux, etc.)
18. `query_devtools_hierarchy` - React/Vue DevTools integration
19. `get_performance_metrics` - Performance monitoring
20. `health_check` - Verify MCP status

## Best Practices

1. **Always build guest-js first** before installing dependencies
2. **Use `--features mcp` flag** when running in development
3. **Keep socket paths consistent** between Rust config and `.mcp.json`
4. **Call `setupPluginListeners()` early** in your frontend initialization
5. **Use `pnpm install --force`** if you encounter resolution issues
6. **Verify the build** by checking for `dist-js/index.js` and `mcp-server-ts/build/index.js`
7. **Restart Vite** after installing the plugin dependency

## Security Note

The MCP plugin should **only be enabled in development builds**. The Rust configuration uses:
```rust
#[cfg(all(debug_assertions, feature = "mcp"))]
```

This ensures the plugin is automatically excluded from production builds.

## Example Usage

### Set Input Value via MCP

```typescript
await mcp__tauri-mcp__execute_js({
  code: `
    const input = document.getElementById('greet-input');
    if (input) {
      input.value = 'John Doe';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `,
  window_label: "main"
});
```

### Take Screenshot and Analyze

```typescript
const screenshot = await mcp__tauri-mcp__take_screenshot({
  window_label: "main"
});
// Screenshot returned as base64 JPEG
```

### Monitor Console Logs

```typescript
await mcp__tauri-mcp__inject_console_capture({ window_label: "main" });
const logs = await mcp__tauri-mcp__get_console_logs({ window_label: "main" });
```

## Resources

- **Integration Guide:** `.tauri-plugin-mcp/docs/INTEGRATION_GUIDE.md`
- **Quick Start:** `.tauri-plugin-mcp/docs/QUICK_START.md`
- **Testing Guide:** `.tauri-plugin-mcp/docs/TESTING_GUIDE.md`
- **Tool Reference:** `.tauri-plugin-mcp/docs/TOOL_PARAMETERS.md`

## Troubleshooting Checklist

- [ ] Guest-js module built (`dist-js/index.js` exists)
- [ ] MCP server built (`mcp-server-ts/build/index.js` exists)
- [ ] `package.json` has `"tauri-plugin-mcp": "file:./.tauri-plugin-mcp"`
- [ ] Dependencies installed with `pnpm install --force`
- [ ] `setupPluginListeners()` called in `src/main.tsx`
- [ ] App running with `--features mcp` flag
- [ ] Socket path consistent between Rust and `.mcp.json`
- [ ] MCP plugin enabled message appears in logs

---

**Last Updated:** 2025-10-22
**Tauri Version:** 2.9
**Plugin Version:** 0.1.0
**Tested On:** macOS (aarch64)

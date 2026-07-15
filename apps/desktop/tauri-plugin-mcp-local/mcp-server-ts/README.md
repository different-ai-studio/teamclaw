# Tauri MCP Server

This is a Model Context Protocol (MCP) server that connects to a Tauri application's socket server to provide tools for controlling and interacting with the Tauri application.

## Overview

The server bridges MCP clients (like LLMs) with a Tauri application by:

1. Connecting to the Tauri socket server via a Unix socket/named pipe
2. Providing MCP tools that map to Tauri functionality
3. Running as a stdio-based MCP server that any MCP client can use

## Available Tools

The server provides the following MCP tools:

### `take_screenshot`

Take a screenshot of a Tauri application window.

**Parameters:**
- `window_label` (optional): The label of the window to capture (default: "main")
- `quality` (optional): JPEG quality from 1-100
- `max_width` (optional): Maximum image width in pixels
- `max_size_mb` (optional): Maximum file size in MB

**Returns:**
- Image content with base64-encoded data

### `execute_js`

Execute JavaScript code in a Tauri window.

**Parameters:**
- `code`: JavaScript code to execute
- `window_label` (optional): The window to execute in (default: "main")
- `timeout_ms` (optional): Maximum execution time in milliseconds

**Returns:**
- The result of the JavaScript execution, serialized as a string

### `get_dom`

Get the HTML DOM content of a Tauri window.

**Parameters:**
- `window_label` (optional): The window to get the DOM from (default: "main")

**Returns:**
- HTML content as a string

### `manage_window`

Control Tauri application windows.

**Parameters:**
- `operation`: Operation to perform (e.g., "focus", "minimize", "maximize", "setPosition", "setSize")
- `window_label` (optional): Target window (default: "main")
- `x` (optional): X position for setPosition
- `y` (optional): Y position for setPosition
- `width` (optional): Width for setSize
- `height` (optional): Height for setSize

**Returns:**
- Success message

### `manage_local_storage`

Manage localStorage in the Tauri webview.

**Parameters:**
- `action`: Action to perform ("get", "set", "remove", "clear", or "keys")
- `key` (optional): Key to get, set, or remove
- `value` (optional): Value to set
- `window_label` (optional): Target window (default: "main")

**Returns:**
- Operation result

## Setup and Usage

1. Ensure the Tauri application is running with the socket server active
2. Start this MCP server
3. Connect your MCP client to this server
4. Use the tools to interact with the Tauri application

The server connects to the Tauri socket at `/private/tmp/tauri-mcp.sock`.

## Error Handling

All tools follow the MCP error reporting convention:
- If a tool succeeds, it returns a result object with `content`
- If a tool fails, it returns an object with `isError: true` and an error message in `content`

## Example

Using the `take_screenshot` tool from an MCP client:

```json
{
  "name": "take_screenshot",
  "arguments": {
    "window_label": "main",
    "quality": 90,
    "max_width": 1920
  }
}
```

The response will include base64-encoded image data that can be rendered or saved as a JPEG file. 
# autoui-mcp

Desktop automation MCP Server – Rust port of pyautogui-mcp.

Provides cross-platform UI automation capabilities through the Model Context Protocol (MCP).

## Features

- 🖱️ Mouse control (move, click, drag)
- ⌨️ Keyboard input and shortcuts
- 📸 Screenshot capture
- 🧠 Intelligent action planning with candidate suggestions (using Qwen3-VL)
- ✅ Vision-based result verification
- 📋 Clipboard operations
- 🪟 Window management

## Installation

### Global Installation

```bash
npm install -g autoui-mcp
# or
pnpm add -g autoui-mcp
```

### Using with pnpm dlx (Recommended)

No installation needed! Use directly:

```bash
pnpm dlx autoui-mcp
```

## Usage

### With OpenCode

Add to your `opencode.json`:

```json
{
  "mcp": {
    "autoui": {
      "type": "local",
      "enabled": true,
      "command": ["pnpm", "dlx", "autoui-mcp@latest"],
      "environment": {
        "QWEN_API_KEY": "your-api-key",
        "QWEN_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "QWEN_MODEL": "qwen3-vl-flash"
      }
    }
  }
}
```

### Standalone

```bash
# Run directly
autoui-mcp

# Or with pnpm dlx
pnpm dlx autoui-mcp
```

## Environment Variables

- `QWEN_API_KEY`: API key for Qwen vision model (required for vision-based features)
- `QWEN_BASE_URL`: Base URL for Qwen API (optional, defaults to Alibaba Cloud)
- `QWEN_MODEL`: Model to use (optional, defaults to qwen3-vl-flash)

## Requirements

- Rust toolchain (for building from source)
- Node.js >= 18 (for npm package)

## Available Tools

### Vision Tools

#### `auto_vision_plan`

**Intelligent action planning with candidates** - Analyzes screen and intent, returns both AI-recommended action and all candidate UI elements.

**Parameters:**
- `intent` (string, required): Task intent (e.g., "login to system", "click close button")
- `context` (array of strings, optional): Previously executed operations

**Returns:**
```json
{
  "intent": "login to system",
  "screen_size": {"width": 1920, "height": 1080},
  "action": {
    "action_type": "type",
    "target": {
      "label": "username field",
      "type": "input",
      "center": {"x": 500, "y": 300},
      "bbox": {"x": 400, "y": 280, "width": 200, "height": 40}
    },
    "params": {"text": "user@example.com"},
    "reasoning": "Found username input, should enter email first",
    "confidence": 0.95
  },
  "candidates": [
    {"label": "username field", "center": {"x": 500, "y": 300}, ...},
    {"label": "password field", "center": {"x": 500, "y": 350}, ...},
    {"label": "login button", "center": {"x": 500, "y": 400}, ...}
  ],
  "total_candidates": 3
}
```

**Action types:**
- `click`: Click element (requires target + params.button/clicks)
- `type`: Type text (requires target + params.text)
- `press`: Press key (requires params.keys, e.g., 'enter', 'command+s')
- `scroll`: Scroll (requires target or screen center + params.scroll_amount)
- `drag`: Drag (currently not supported, suggest decomposing to click + move)
- `wait`: Wait for loading (requires params.wait_reason)
- `done`: Task completed

**Usage:**
- **For complex multi-step tasks**: Follow AI recommendation (use `action.action_type`, `action.target`, `action.params`)
- **For simple single-step tasks**: Choose from `candidates` and decide action yourself

#### `auto_vision_verify`

**Result verification** - Takes a screenshot and judges whether the current screen state matches the expected assertion.

**Parameters:**
- `assertion` (string, required): Expected screen state description (e.g., "file successfully opened")
- `action_performed` (string, optional): Description of just-performed action for context

**Returns:**
```json
{
  "assertion": "window closed",
  "passed": true,
  "confidence": 0.95,
  "reason": "The window is no longer visible on screen"
}
```

### Mouse Tools

- `auto_mouse_click`: Click at coordinates (supports left/right/middle button, single/double-click)
- `auto_mouse_move`: Move mouse to coordinates (hover)
- `auto_mouse_scroll`: Scroll mouse wheel (positive=up, negative=down)
- `auto_mouse_drag`: Drag from start to end coordinates

### Keyboard Tools

- `auto_keyboard_type`: Type text (supports Unicode via clipboard)
- `auto_keyboard_press`: Press key or key combination (e.g., 'enter', 'ctrl+c', 'command+v')

## Workflow: plan → act → verify

### Step 1: Plan

Call `auto_vision_plan` to get AI recommendation and candidates:

```python
result = auto_vision_plan(
    intent="login to system",
    context=[]  # or ["entered username", "clicked next"]
)
```

### Step 2: Act

**Option A: Follow AI recommendation (for complex tasks)**

```python
action = result.action
if action.action_type == "click":
    auto_mouse_click(
        x=action.target.center.x,
        y=action.target.center.y,
        clicks=action.params.clicks or 1
    )
elif action.action_type == "type":
    auto_mouse_click(x=action.target.center.x, y=action.target.center.y)
    auto_keyboard_type(text=action.params.text)
elif action.action_type == "press":
    auto_keyboard_press(keys=action.params.keys)
elif action.action_type == "scroll":
    if action.target:
        auto_mouse_click(x=action.target.center.x, y=action.target.center.y)
    auto_mouse_scroll(clicks=action.params.scroll_amount)
```

**Option B: Choose from candidates (for simple tasks)**

```python
# Pick the first (most relevant) candidate
target = result.candidates[0]
auto_mouse_click(x=target.center.x, y=target.center.y)
```

### Step 3: Verify

```python
verify_result = auto_vision_verify(assertion="logged in successfully")
if not verify_result.passed:
    # Retry or handle error
```

### Complete Examples

**Example 1: Complex task (follow AI recommendation)**

```python
# Task: Login to system
context = []

# Plan first action
result = auto_vision_plan(intent="login to system", context=context)
# Execute recommendation
auto_mouse_click(x=result.action.target.center.x, y=result.action.target.center.y)
auto_keyboard_type(text=result.action.params.text)
context.append("Entered username")

# Plan next action
result = auto_vision_plan(intent="continue login", context=context)
# Execute
auto_mouse_click(x=result.action.target.center.x, y=result.action.target.center.y)
auto_keyboard_type(text="password")
context.append("Entered password")

# Continue until action_type == "done"
```

**Example 2: Simple task (choose from candidates)**

```python
# Task: Click close button
result = auto_vision_plan(intent="close button", context=[])

# Choose from candidates
target = result.candidates[0]
auto_mouse_click(x=target.center.x, y=target.center.y)

# Verify
verify_result = auto_vision_verify(assertion="window closed")
```

## License

MIT

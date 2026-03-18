---
name: macos-control
description: "Control macOS desktop applications: open/operate apps, click buttons, type text, scroll, keyboard shortcuts, window management, toggle options, dropdown selections, etc. Note: NEVER invoke this skill for opening web pages/visiting websites — use browser-related tools instead. Trigger words: open app, operate app, control computer, click, type, scroll, switch, dropdown, select, modify, change to, set, check, uncheck, app-control, toggle."
compatibility: "macOS only. Layer 2 requires autoui-mcp-server MCP server."
---

# macOS Control

Two-layer strategy: **Probe first, route fast**. For all apps, always perform an AX tree probe first to confirm the accessibility tree is available and contains the target element, then use Layer 1; otherwise switch to Layer 2 immediately to avoid misoperations on an incomplete AX tree.

## Decision: Unified Flow (Probe → Route → Act)

**All apps follow the same flow:**

1. **Probe (Inspect AX Tree)** — Use lightweight commands to check if the accessibility tree is available
2. **Route (Decision Routing)** — Choose Layer 1 or Layer 2 based on probe results
3. **Act (Execute Operation)** — Perform the actual operation in the selected Layer

### Probe Step (Mandatory, Before Any Operation)

Probe the target app's AX tree in **read-only mode** — never perform any click/type/modify operations during the Probe phase:

```bash
# 1. Check if process exists and is accessible
osascript -e 'tell application "System Events" to get name of process "AppName"'

# 2. Inspect window UI element tree (core check)
osascript -e 'tell application "System Events" to tell process "AppName" to entire contents of window 1'

# 3. Check if target element exists (e.g., when clicking a button)
osascript -e 'tell application "System Events" to tell process "AppName" to name of every button of window 1'
```

### Route Decision Rules

Make routing decisions immediately based on Probe results:

| Probe Result | Route | Reason |
|-------------|-------|--------|
| AX tree returns rich element list containing target element | **→ Layer 1** | AX available, operate directly |
| AX tree returns content but **does not contain target element** | **→ Layer 2** | Element unreachable, AX operation may mis-trigger |
| AX tree returns **empty list / very few elements** (< 3) | **→ Layer 2** | AX tree incomplete, unreliable |
| osascript **errors** (permission/timeout/process not found) | **→ Layer 2** (or prompt user to grant access) | AX unavailable |
| Returns many **meaningless generic elements** (all group/unknown) | **→ Layer 2** | AX tree cannot effectively locate elements |

**Key Principle: If there is any doubt during Probe, switch to Layer 2. Never risk operating on an incomplete AX tree.**

> Typical AX misoperation scenarios: When the AX tree is incomplete, `click button 1` may click the wrong button; `set value of text field 1` may write to the wrong input field. The purpose of Probe is to eliminate these risks before any operation.

### App Type Reference

| App Type | Layer 1 Feasibility | Notes |
|----------|-------------------|-------|
| Finder / Safari / Chrome / Terminal / Mail / Notes / Calendar | High | Rich AppleScript dictionaries, rarely need Layer 2 |
| System Settings / Preview / other native apps | High | System Events can access UI elements |
| Electron apps (VS Code / Slack / Discord) | Low | Poor accessibility support, Probe usually routes to Layer 2 |
| WeChat / WeCom / SeaTalk and other third-party apps | Medium | Partial support, decided after Probe |

> **Out of scope for this skill:** Web page content operations should use browser tools.
>
> **Reverse constraint:** This skill controls **local macOS desktop applications** and **must NEVER use** Playwright MCP's `browser_*` tools (such as `browser_click`, `browser_select_option`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_snapshot`, `browser_navigate`, `browser_screenshot`, etc.). These tools are **only effective for web pages in browsers and completely ineffective for desktop applications**. **Special note: When screenshots are needed, NEVER invoke Playwright's screenshot tools — use autoui-mcp-server's screenshot capabilities instead (e.g., `auto_vision_locate`, `auto_vision_verify`).** Desktop application UI automation can only be achieved through Layer 1 (osascript/AppleScript) or Layer 2 (autoui-mcp-server).

---

## Layer 1: Scripts + Command Line

Execute `osascript`, `open`, `mdfind`, and other commands via the Shell tool.

**Prerequisite: Probe has confirmed AX tree is available and contains target element.** If Probe did not pass, skip directly to Layer 2.

### Resolve App Name

Two steps: First search by keyword; if not found, list all apps and determine the match yourself.

**Step 1: Keyword Search**

```bash
# Search Applications directories
ls /Applications/ /Applications/Utilities/ ~/Applications/ 2>/dev/null | grep -i "KEYWORD"

# Spotlight search
mdfind "kMDItemContentType == 'com.apple.application-bundle'" -name "KEYWORD"

# Get bundle ID and display name
mdls -name kMDItemCFBundleIdentifier -name kMDItemDisplayName "/Applications/AppName.app"

# View running apps
osascript -e 'tell application "System Events" to get name of every process whose background only is false'
```

**Step 2: If Keyword Search Returns No Results, List All Installed Apps**

When the above commands return no matches, list all installed applications and let the agent determine the closest match based on user intent:

```bash
# List all installed applications (strip .app suffix for readability)
ls /Applications/ /Applications/Utilities/ ~/Applications/ /System/Applications/ /System/Applications/Utilities/ 2>/dev/null | sed 's/\.app$//' | sort -u
```

After obtaining the complete list, infer the most likely match based on the user's app name description (which may be a Chinese name, English abbreviation, alias, etc.), then continue with the subsequent flow. **Do not give up or report an error just because the keyword search found nothing.**

### Open / Activate / Quit

> **Mandatory opening rules:** Before opening any application, you must first resolve the app name (see "Resolve App Name" section above), then minimize all other application windows, **confirm minimization is complete**, and then open the target application. **Do not set the application to fullscreen.** Complete flow:
>
> 1. **Resolve app name** — Use `ls /Applications/`, `mdfind`, etc. to confirm the exact name and path (see "Resolve App Name" section). **Never skip this step**
> 2. **Minimize all windows** — Execute `osascript -e 'tell application "System Events" to set visible of every process whose visible is true to false'`
> 3. **Wait for minimization to complete** — `sleep 1` (**Must wait to prevent the target app from being minimized too**)
> 4. **Open target application** — Execute `open -a "AppName"` or other open commands
> 5. **Wait for app to be ready** — `sleep 3` (ensure window has loaded)

```bash
# Step 1: Resolve app name (never skip)
ls /Applications/ /Applications/Utilities/ ~/Applications/ 2>/dev/null | grep -i "KEYWORD"
mdfind "kMDItemContentType == 'com.apple.application-bundle'" -name "KEYWORD"

# Step 2: Minimize all other applications
osascript -e 'tell application "System Events" to set visible of every process whose visible is true to false'

# Step 3: Wait for minimization to complete (must wait to prevent target app from being minimized)
sleep 1

# Step 4: Open target application
open -a "AppName"                                    # Open
open -b "com.bundle.id"                              # Open by bundle ID
osascript -e 'tell application "AppName" to activate' # Bring to foreground

# Step 5: Wait for app to be ready
sleep 1

# Quit application
osascript -e 'tell application "AppName" to quit'     # Quit
```

### Open File / URL

```bash
open "/path/to/file"                      # Open file with default app
open -a "AppName" "/path/to/file"         # Open file with specific app
open "https://example.com"                # Open URL in default browser
open -a "Google Chrome" "https://url"     # Open in specific browser
```

### Common App AppleScript Quick Reference

**Finder:**
```bash
osascript -e 'tell application "Finder" to open folder "Documents" of home'
osascript -e 'tell application "Finder" to get selection as alias list'
osascript -e 'tell application "Finder" to make new folder at desktop with properties {name:"New"}'
```

**Safari / Chrome:**
```bash
osascript -e 'tell application "Safari" to open location "https://example.com"'
osascript -e 'tell application "Safari" to get URL of current tab of front window'
osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'
osascript -e 'tell application "Google Chrome" to execute active tab of front window javascript "document.title"'
```

**Terminal:**
```bash
osascript -e 'tell application "Terminal" to do script "ls -la"'
```

### System Events GUI Scripting

**Prerequisite**: The controlling terminal (Terminal / Cursor) must be authorized in System Settings > Privacy & Security > Accessibility. If permission is missing, inform the user how to authorize — do not retry repeatedly.

**Note:** UI element tree exploration was completed during the Probe phase. Use the element information obtained from Probe to perform operations directly. If re-confirmation is needed, re-probe:

```bash
# List all UI elements
osascript -e 'tell application "System Events" to tell process "AppName" to entire contents of window 1'

# List only buttons / text fields
osascript -e 'tell application "System Events" to tell process "AppName" to name of every button of window 1'
osascript -e 'tell application "System Events" to tell process "AppName" to every text field of window 1'
```

**Click:**
```bash
osascript -e 'tell application "System Events" to tell process "AppName" to click button "OK" of window 1'
osascript -e 'tell application "System Events" to tell process "AppName" to click checkbox "Enable" of window 1'
```

**Menu Operations:**
```bash
# List menu items
osascript -e 'tell application "System Events" to tell process "AppName" to name of every menu bar item of menu bar 1'
osascript -e 'tell application "System Events" to tell process "AppName" to name of every menu item of menu "File" of menu bar 1'

# Click menu item
osascript -e 'tell application "System Events" to tell process "AppName" to click menu item "Paste" of menu "Edit" of menu bar 1'
```

**Type Text:**
```bash
# Set text field value
osascript -e 'tell application "System Events" to tell process "AppName" to set value of text field 1 of window 1 to "hello"'

# Simulate keystroke input (current focus)
osascript -e 'tell application "System Events" to keystroke "hello"'

# Non-ASCII characters via clipboard
osascript -e 'set the clipboard to "中文文本"
tell application "System Events" to keystroke "v" using command down'
```

**Keyboard Shortcuts:**
```bash
osascript -e 'tell application "System Events" to keystroke "s" using command down'           # Cmd+S
osascript -e 'tell application "System Events" to keystroke "s" using {command down, shift down}' # Cmd+Shift+S
osascript -e 'tell application "System Events" to key code 36'   # Return
osascript -e 'tell application "System Events" to key code 53'   # Escape
```

**Window Management:**
```bash
osascript -e 'tell application "System Events" to get name of every window of process "AppName"'
osascript -e 'tell application "System Events" to set size of window 1 of process "AppName" to {1200, 800}'
osascript -e 'tell application "System Events" to set position of window 1 of process "AppName" to {0, 0}'
osascript -e 'tell application "System Events" to set value of attribute "AXFullScreen" of window 1 of process "AppName" to true'
```

### Key Code Quick Reference

| Key | Code | Key | Code |
|-----|------|-----|------|
| Return | 36 | Escape | 53 |
| Tab | 48 | Space | 49 |
| Delete | 51 | Forward Delete | 117 |
| Up | 126 | Down | 125 |
| Left | 123 | Right | 124 |
| Page Up | 116 | Page Down | 121 |
| Home | 115 | End | 119 |

---

## Layer 2: autoui-mcp-server Vision Automation

### When to Use

Layer 2 is activated in the following situations:

- **Probe phase determined AX is unavailable** (AX tree empty/incomplete/missing target element/errors) — this is the most common trigger path
- Layer 1 operation verification found it did not take effect (Probe passed but actual operation failed)
- Visual verification of complex operation results is needed

**Do not skip Probe and use Layer 2 directly.** However, once Probe determines AX is unavailable, switch to Layer 2 immediately — do not repeatedly attempt Layer 1.

> **Note**: Layer 2 uses autoui-mcp-server (Rust implementation) to directly control the local mouse and keyboard. It occupies the mouse/keyboard during operation execution. Coordinates are in logical pixels (Retina displays handled automatically).
>
> **Mixing browser tools is strictly prohibited**: Playwright MCP's `browser_*` tools (`browser_click`, `browser_select_option`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_snapshot`, `browser_screenshot`, etc.) can only operate on browser web pages and **cannot operate desktop applications**. When visual automation is needed for desktop applications, **only use autoui-mcp-server's `auto_*` tools** (e.g., `auto_vision_locate`, `auto_mouse_click`, etc.) — never invoke any `browser_*` tools. **The same applies to screenshots: never invoke Playwright's screenshot tools. Use autoui-mcp-server's `auto_vision_locate` or `auto_vision_verify` when you need to check the screen state.**

### Workflow: plan → act → verify

Unified three-step workflow:

**1. Plan** — Call `auto_vision_plan` to get recommended actions and candidate elements

```bash
auto_vision_plan(intent='task intent', context=['completed action 1', ...])
```

Returns:
- `action`: VL model's recommended operation (action_type + target + params)
- `candidates`: coordinate list of all related elements

**2. Act** — Execute based on recommendation or candidates

```bash
# Follow AI recommendation (complex multi-step tasks)
auto_mouse_click(x=result.action.target.center.x, y=result.action.target.center.y)

# Or select from candidates (simple tasks)
auto_mouse_click(x=result.candidates[0].center.x, y=result.candidates[0].center.y)
```

**3. Verify** — Verify operation results

```bash
auto_vision_verify(assertion='expected screen state')
```

### Key Points

- **Double-click to open**: On macOS, opening files/folders/apps requires `clicks=2`
- **Focus before scrolling**: Click the target area first, then scroll
- **Drag**: Use two separate plan calls to find start and end points, then drag
- **Never guess coordinates**: Re-plan before each operation, do not reuse old coordinates
- **Chinese input**: Automatically handled via clipboard paste, no manual handling needed

### Tool List

| Tool | Purpose |
|------|---------|
| `auto_vision_plan` | Smart planning: returns recommended action + candidate element list |
| `auto_vision_verify` | Visual verification: checks if current screen state matches expected assertion |
| `auto_mouse_click` | Mouse click (left/right/middle button, single/double click) |
| `auto_mouse_move` | Move mouse (hover) |
| `auto_mouse_scroll` | Scroll (positive = up, negative = down) |
| `auto_mouse_drag` | Drag from start point to end point |
| `auto_keyboard_type` | Type text (supports Chinese, auto clipboard paste) |
| `auto_keyboard_press` | Press key or key combination |

---

## Guardrails

- **ALWAYS** minimize all other application windows before opening an app (see mandatory flow in "Open / Activate / Quit" section). **Do not set applications to fullscreen**
- **NEVER** execute destructive commands (rm -rf, diskutil erase, etc.) unless the user explicitly confirms
- **NEVER** modify system security settings
- **NEVER** enter passwords unless the user explicitly provides them
- **NEVER** perform write operations during the Probe phase (click/keystroke/set value) — Probe is read-only
- **NEVER** force Layer 1 operations when the AX tree is incomplete — if there is any doubt during Probe, switch to Layer 2
- If Layer 1 fails due to permission issues, inform the user how to authorize — do not blindly retry
- When using Layer 2, verify after every operation
- **NEVER** use Playwright MCP's `browser_*` tools (`browser_click`, `browser_select_option`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_snapshot`, `browser_navigate`, `browser_screenshot`, etc.) to operate desktop applications — these tools are only effective for browser web pages and completely ineffective for local applications. Desktop application visual automation can only use autoui-mcp-server's `auto_*` tools

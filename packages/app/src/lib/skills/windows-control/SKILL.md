---
name: windows-control
description: "Control Windows desktop applications: open/operate apps, click controls, type text, scroll, keyboard shortcuts, window management, toggle options, lists and combos, etc. Note: NEVER invoke this skill for opening web pages/visiting websites — use browser-related tools instead. Trigger words: open app, operate app, control computer, click, type, scroll, switch, dropdown, select, modify, change to, set, check, uncheck, app-control, toggle."
compatibility: "Windows only. Layer 2 requires autoui-mcp-server MCP server."
---

# Windows Control

Two-layer strategy: **Probe first, route fast**. For all apps, probe UI Automation (UIA) accessibility first to confirm the tree is usable and contains the target element, then use Layer 1; otherwise switch to Layer 2 immediately to avoid misoperations on an incomplete tree.

## Decision: Unified Flow (Probe → Route → Act)

**All apps follow the same flow:**

1. **Probe (Inspect UIA / window)** — Lightweight read-only checks that the target window/process exists and automation peers are discoverable.
2. **Route (Decision Routing)** — Choose Layer 1 or Layer 2 from probe results.
3. **Act (Execute Operation)** — Perform the operation in the selected layer.

### Probe Step (Mandatory, Before Any Operation)

Probe in **read-only** mode — no clicks, no focus changes that perform actions:

```powershell
# 1. Process exists
Get-Process -Name "Notepad" -ErrorAction SilentlyContinue

# 2. List top-level windows with title (filter empty titles if needed)
Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Name, Id, MainWindowTitle
```

For deeper UIA inspection from PowerShell (when `.NET` UIA is available):

```powershell
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [Windows.Automation.AutomationElement]::RootElement
# Walk children or use WindowPattern — scope narrowly to the target process/main window
```

If UIA APIs are unavailable or the tree is empty/generic, treat as **fail probe → Layer 2**.

### Route Decision Rules

| Probe Result | Route | Reason |
|-------------|-------|--------|
| Rich control tree; target element identifiable | **→ Layer 1** | UIA usable |
| Tree present but **target not found** | **→ Layer 2** | Wrong or partial tree |
| Tree **sparse** (few elements) or mostly `Pane`/`Custom` with no names | **→ Layer 2** | Unreliable |
| Errors (access denied, process not found, timeout) | **→ Layer 2** (or ask user to run as appropriate / grant access) | UIA unavailable |
| Many unnamed duplicates | **→ Layer 2** | Ambiguous |

**If in doubt after Probe, choose Layer 2.**

> **Out of scope:** Web page operations → browser tools only.
>
> **Reverse constraint:** This skill targets **local Windows desktop applications**. **Never use** Playwright MCP `browser_*` tools (`browser_click`, `browser_select_option`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_snapshot`, `browser_navigate`, `browser_screenshot`, …) for desktop UI — they only affect web pages. For desktop screenshots or vision steps, use **autoui-mcp-server** (`auto_vision_*`, `auto_mouse_*`, `auto_keyboard_*`).

---

## Layer 1: PowerShell + Shell

Run `powershell.exe`, `pwsh.exe`, `cmd`, `start`, and Windows utilities via the Shell tool.

**Prerequisite:** Probe indicates UIA (or window focus strategy) is viable. Otherwise skip to Layer 2.

### Resolve Application

```powershell
# Installed apps (Start Menu shortcuts — adjust user name if needed)
Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Select-Object FullName
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Select-Object FullName

# Running processes with UI
Get-Process | Where-Object MainWindowHandle -ne 0 | Select-Object Name, Id, MainWindowTitle
```

### Open / Focus / Close

> **Before opening:** Resolve the exact executable or shortcut name. Prefer `Start-Process` with `-WindowStyle Normal`. Avoid forcing fullscreen.

```powershell
# Launch
Start-Process "notepad"
Start-Process "C:\Path\App.exe" -ArgumentList '--flag'

# Bring existing to foreground (conceptual — may require Win32 ShowWindow in some cases)
# Prefer UIA / Layer 2 if focus APIs misbehave.

# Close gracefully
Stop-Process -Name "Notepad" -ErrorAction SilentlyContinue
```

### File / URI

```powershell
Start-Process "C:\path\file.txt"           # Default handler
Start-Process "msedge" "https://example.com"  # Example browser — still, prefer browser tools for *web* tasks
```

### UIA-Oriented Operations (When Probe Passed)

Use narrowly scoped scripts: find the automation element by `AutomationId`, `Name`, or control type, then invoke `InvokePattern`, `ValuePattern`, `TogglePattern`, etc. If scripting becomes brittle, switch to Layer 2.

### Keyboard Shortcuts (Windows)

- **Ctrl** replaces macOS **Cmd** for most shortcuts (e.g. save: **Ctrl+S**).
- **Alt** accesses menus; **Alt+F4** closes foreground window.
- **Win** opens Start; **Win+D** shows desktop.

---

## Layer 2: autoui-mcp-server Vision Automation

Same role as on macOS: when UIA is insufficient or visual verification is required.

**Do not skip Probe** to jump here without reason; once Probe fails, use Layer 2 promptly.

### Workflow: plan → act → verify

1. `auto_vision_plan(intent='...', context=[...])`
2. `auto_mouse_click` / `auto_keyboard_type` / `auto_mouse_scroll` / `auto_mouse_drag` as appropriate
3. `auto_vision_verify(assertion='...')`

### Notes (Windows)

- **Double-click** to open files in Explorer may need `clicks=2`.
- **Focus before scroll**: click the target region first.
- **Never guess coordinates** — re-plan when the layout changes.

### Tool List

| Tool | Purpose |
|------|---------|
| `auto_vision_plan` | Plan + candidate elements |
| `auto_vision_verify` | Visual assertion |
| `auto_mouse_click` | Click (incl. double) |
| `auto_mouse_move` | Hover |
| `auto_mouse_scroll` | Scroll |
| `auto_mouse_drag` | Drag |
| `auto_keyboard_type` | Text entry |
| `auto_keyboard_press` | Key chords |

---

## Guardrails

- **Never** run destructive commands (`Format-Volume`, mass `Remove-Item -Recurse` on system paths, etc.) without explicit user confirmation.
- **Never** weaken security products or UAC prompts automatically.
- **Never** type secrets/passwords unless the user supplied them explicitly for that step.
- **Probe is read-only** — no mutating UI actions during Probe.
- Prefer Layer 2 when UIA is ambiguous; verify after Layer 2 steps.
- **No Playwright `browser_*`** for desktop UI; use **autoui `auto_*`** only.

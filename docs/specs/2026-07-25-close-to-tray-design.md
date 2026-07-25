# Close → Tray (default) — Design

Date: 2026-07-25  
Branch: `feat/close-to-tray`  
Mockup: `docs/specs/2026-07-25-close-to-tray-mockup.html`

## Goal

When the user closes the main window, ask whether to **minimize to tray** (keep `amuxd` running) or **quit and stop the agent**. Default selection: **tray**. Optional “remember”.

Tray menu gains **本地 Agent 设置**, which shows the main window and opens the same `LocalDaemon` sheet as the sidebar footer.

## Behavior

| Action | Result |
|--------|--------|
| Window close (● red) + no remembered pref | Show dialog; default = tray |
| Remembered = tray | Hide to tray; no dialog; amuxd keeps running |
| Remembered = quit | `app.exit(0)` → existing amuxd shutdown |
| Cmd+Q / tray “退出并停止 Agent” | Full quit + shutdown (no dialog) |
| Tray “打开主窗口” / dock reopen / left-click tray | Show main window |
| Tray “本地 Agent 设置” | Open standalone Settings window (~960×780) with full sidebar, landing on `daemonGeneral` — **does not** show the main window |

## Resource release (v1)

Hide the main window (existing path). Do **not** destroy the WebView in v1 (recreate is fragile). Emit `app-entered-tray` so the frontend can later pause heavy UI work. Full WebView teardown is a follow-up.

## Preference storage

Rust-owned, persisted under app config dir as `window-close.json`:

```json
{ "action": "tray" | "quit" }
```

Absence of file / `action: null` ⇒ ask every time. Frontend syncs via `set_window_close_preference` when the user checks “记住”.

## IPC

- Event `window-close-requested` → frontend dialog
- Command `hide_main_to_tray`
- Command `quit_app`
- Command `get_window_close_preference` / `set_window_close_preference`
- Event `open-local-daemon-sheet` → `useUIStore.setLocalDaemonSheetOpen(true)`
- Event `app-entered-tray` (informational)

## Out of scope

- Destroying/recreating the WebView on tray
- Changing Cmd+Q to show the same dialog
- Auto-cleaning `~/.amuxd/bin`

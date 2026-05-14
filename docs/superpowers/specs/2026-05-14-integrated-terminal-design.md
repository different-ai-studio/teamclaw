# TeamClaw Integrated Terminal

**Date:** 2026-05-14
**Status:** Approved (pending implementation plan)
**Target version:** v2.0.0
**Branch:** `v2/amuxd-architecture`

## Overview

Add a VS Code–style integrated terminal to TeamClaw's ChatPanel: a real PTY (running the user's `$SHELL`) embedded as a bottom split below the chat surface, scoped to the current workspace, multi-tab, process-lifetime persistent, and entirely local to the desktop client. The terminal is a human-only surface — its input and output never enter the v2 MQTT bus and are not visible to other session participants or agents.

This spec covers the **TeamClaw desktop client only**. It is a self-contained subsystem alongside `oss_sync` / `team_p2p` / `gateway` in `src-tauri/src/commands/`, with no coupling to the amuxd / Supabase / EMQX runtime introduced by [[amuxd-architecture-design]].

## Goals

- Let a human run real interactive shell commands (`vim`, `pnpm dev`, `git rebase -i`, etc.) inside TeamClaw without context-switching to an external terminal app.
- Share the same workspace filesystem the agent operates on, so users can inspect / verify / fix what the agent does without leaving the chat window.
- Match VS Code's mental model on multiplicity, lifetime, and keyboard shortcut so users don't have to relearn anything.
- Keep the subsystem **decoupled from v2's collab story**: zero MQTT traffic, zero Supabase rows, zero new permission surface.

## Non-Goals (v1)

- **Agent ↔ terminal interaction.** Agents cannot read terminal output or write to it. No "run in terminal" button on chat code blocks. No "send selection to agent" from terminal. v1 ships with **zero cross-surface integration**; revisit in v2 once usage patterns are clear.
- **Cross-collaborator visibility.** Terminal I/O stays on the local machine. Other humans in the session do not see what was run. No `Envelope` variants are added to amuxd's `amux.proto`.
- **Cross-restart persistence.** Closing the main TeamClaw window kills all PTYs. No background daemon, no tmux-style reattach. Workspace switch hides the panel but keeps PTYs alive within the running process — this is the only persistence guarantee.
- **Remote PTYs.** Always spawned on the user's local machine. A remote daemon's host shell is out of scope (and contradicts the "human-only surface" framing).
- **Terminal profiles / startup tasks.** No "auto-run `pnpm dev` on open", no saved profile presets. Users get one default shell, configurable via `$SHELL`.
- **Search within terminal output.** Browser-style `Cmd+F` in xterm buffer is not wired in v1.
- **Windows in smoke tests.** Code paths support Windows via ConPTY, but v1 E2E coverage is macOS only — consistent with [[amuxd-architecture-design]]'s "Mac/Linux first" posture.

## Decision Log

| ID | Question | Decision |
|---|---|---|
| Q1 | What's the terminal for? | Human-driven PTY sharing the workspace filesystem with agents. Not an agent-output mirror, not a collab surface, not an amuxd debug view. |
| Q2 | Who sees the terminal I/O? | Local user only. Pure desktop subsystem. No MQTT traffic. |
| Q3 | What does a terminal "belong to"? | A workspace. Switching workspaces hides the panel; the PTY keeps running. |
| Q4 | Multiplicity? | Multi-tab within a workspace. `+` button on tab bar, `⌘ + T` to add, `⌘ + W` to close (when terminal is focused). |
| Q5 | Physical placement? | Bottom split of ChatPanel. Resizable, default ~35% of ChatPanel height. |
| Q6 | Lifetime? | Process-lifetime. Workspace switch keeps PTYs alive. App close kills them all. No reattach across restarts. |
| Q7 | Agent integration in v1? | Zero. No "run in terminal" buttons, no "send to agent" right-click. |
| Q8 | Tech stack? | `portable-pty` in Rust + `@xterm/xterm` in React. ANSI parsing happens in xterm.js; Rust ferries raw bytes only. |
| Q9 | Toggle keyboard shortcut? | `⌃` + `` ` `` (Control + backtick), VS Code parity. |
| Q10 | UI entry point? | Lucide `TerminalSquare` icon in the ChatPanel header, immediately right of the existing `AppWindow` (file-tabs) icon. |

---

## Section 1 — High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     TeamClaw process                          │
│                                                               │
│  ┌─────────────────────────┐    Tauri command/event           │
│  │ React (Frontend)        │  ◄────────────────────┐          │
│  │                         │                       │          │
│  │ TerminalPanel (xterm)   │                       │          │
│  │   ├── TabBar            │                       │          │
│  │   └── XtermInstance ×N  │                       │          │
│  │                         │                       │          │
│  │ terminal-store.ts       │                       │          │
│  │   tabsByWorkspace       │                       │          │
│  │   activeTabByWorkspace  │                       │          │
│  │   panelOpenByWorkspace  │                       │          │
│  └────────┬────────────────┘                       │          │
│           │ invoke / listen                        │          │
│           ▼                                        │          │
│  ┌─────────────────────────┐                       │          │
│  │ Rust (Tauri backend)    │                       │          │
│  │                         │                       │          │
│  │ commands/terminal.rs    │                       │          │
│  │   terminal_open         │                       │          │
│  │   terminal_subscribe    │                       │          │
│  │   terminal_write        │                       │          │
│  │   terminal_resize       │                       │          │
│  │   terminal_close        │                       │          │
│  │   terminal_list         │                       │          │
│  │                         │                       │          │
│  │ terminal/registry.rs    │                       │          │
│  │   PtyHandle ×N (Arc)    │                       │          │
│  │   reader threads ─────► emits `terminal://{id}/data`       │
│  │                                 `terminal://{id}/exit`     │
│  └────────┬────────────────┘                                  │
│           │ portable-pty                                       │
│           ▼                                                    │
│      [ user's $SHELL ] cwd = workspace_path                    │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 Boundary properties

1. **No MQTT, no Supabase.** The terminal subsystem does not touch the v2 collab bus. It cannot write to `session/{id}/live`. It cannot read `session_actors`. It is a pure local subsystem at the same architectural tier as `oss_sync` and `team_p2p`.
2. **No cross-process persistence.** All `PtyHandle` instances live inside the Rust process's `OnceLock<Registry>`. Dropping the app drops them.
3. **Workspace switch is UI-only.** The store buckets tabs by `workspaceId`; switching workspace unmounts `XtermInstance` components but leaves PTYs running. Switching back rehydrates from `terminal_list` and replays the ring buffer.
4. **Human-only.** No code path emits terminal data onto MQTT. No Tauri command writes terminal data into chat input or Envelope payloads.

---

## Section 2 — Rust Backend

### 2.1 File layout

```
src-tauri/src/
├── commands/
│   └── terminal.rs           # Tauri commands (~150 LOC)
└── terminal/
    ├── mod.rs                # pub use; register Registry into tauri::State
    ├── registry.rs           # PtyHandle store, ring buffer (~150 LOC)
    └── pty.rs                # PTY spawn + reader thread (~120 LOC)
```

### 2.2 Cargo dependency

```toml
portable-pty = "0.8"
```

`portable-pty` is the wezterm-maintained crate; it abstracts Unix PTY (Linux/macOS) and Windows ConPTY behind a uniform `MasterPty` / `Child` trait pair.

### 2.3 Data structures (`terminal/registry.rs`)

```rust
pub struct TerminalId(String);   // UUIDv7 string

pub struct PtyHandle {
    pub id: TerminalId,
    pub workspace_id: String,    // Bucket key for workspace-switch hide/show
    pub cwd: PathBuf,            // Initial cwd; not tracked at runtime
    pub shell: String,           // The shell actually spawned
    pub rows: u16,
    pub cols: u16,
    pub pid: u32,

    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    ring: Arc<Mutex<RingBuffer>>,  // 8 MiB capacity
}

pub struct Registry {
    handles: RwLock<HashMap<TerminalId, Arc<PtyHandle>>>,
}

pub struct RingBuffer {
    buf: Box<[u8]>,
    head: usize,    // write head
    filled: bool,   // once head wraps the buffer is full
}
```

`RingBuffer::snapshot()` returns the logical bytes in order (`buf[head..]` + `buf[..head]` when `filled`, else `buf[..head]`).

### 2.4 Tauri commands (`commands/terminal.rs`)

| Command | Args | Return | Behavior |
|---|---|---|---|
| `terminal_open` | `workspace_id`, `cwd`, `cols`, `rows`, optional `shell` | `{ id, shell, pid }` | Spawn PTY, start reader thread, insert into Registry. Env = parent env + `TERM=xterm-256color` + `COLORTERM=truecolor` + `TEAMCLAW_TERMINAL=1`. |
| `terminal_subscribe` | `id` | `{ ring_snapshot: Vec<u8>, rows, cols, status }` | Return current ring buffer contents for replay on remount. Does **not** spawn. |
| `terminal_write` | `id`, `data: Vec<u8>` | `()` | Write to master writer. Returns `TerminalError::PtyClosed` if exited. |
| `terminal_resize` | `id`, `cols`, `rows` | `()` | Call `master.resize(PtySize { cols, rows, .. })`. |
| `terminal_close` | `id` | `()` | `child.kill()` + `child.wait()` + remove from Registry. |
| `terminal_list` | `workspace_id` | `Vec<TerminalSummary>` | Hydration: `{ id, shell, pid, status, exit_code }` for all tabs of a workspace. |

### 2.5 Reader thread

For each PTY, `std::thread::spawn` holding `Arc<AppHandle>` and `Arc<Mutex<RingBuffer>>`:

```
loop {
    let mut tmp = [0u8; 4096];
    match master_reader.read(&mut tmp) {
        Ok(0)        => break,                              // EOF
        Ok(n)        => {
            ring.lock().write_overwrite(&tmp[..n]);
            batch.extend_from_slice(&tmp[..n]);
            if batch.len() >= 4096 || since_last_emit > 10ms {
                app.emit(&format!("terminal://{id}/data"), batch.clone())?;
                batch.clear();
            }
        }
        Err(e)       => break,
    }
}
flush(&batch);
app.emit(&format!("terminal://{id}/exit"), exit_payload)?;
```

**Batching rationale.** Per-byte `emit` round-trips through Tauri's IPC and saturates the channel under high-throughput output. Batching to 4 KiB or 10 ms (whichever first) keeps interactive latency below the perceptual threshold while preventing IPC starvation.

**Channel saturation.** Under extreme output (`cat /dev/urandom`), if `emit` returns an error (channel full), the reader **drops the frame** and continues. We intentionally do **not** back-pressure into the PTY — that would block the child process via pipe stall, which is a worse failure mode than a few dropped frames. The ring buffer still records the bytes; only the live stream loses them. Known limitation, documented in commands/terminal.rs.

**Panic safety.** The reader thread body is wrapped in `std::panic::catch_unwind`; on panic, emit `exit` with a synthetic error code and remove the handle from the Registry.

### 2.6 Shell selection

1. If caller supplied `shell` arg, use it.
2. Else read `$SHELL`.
3. Else fall back: macOS `/bin/zsh`, Linux `/bin/bash`, Windows `powershell.exe`.

Launch as login shell where applicable (`-l` for zsh/bash) so `.zshrc` / `.bashrc` / `.profile` are sourced. Windows pwsh has no `-l` analogue.

### 2.7 cwd validation (security boundary)

`terminal_open` validates that the supplied `cwd` canonicalizes to a path **inside one of the workspaces currently registered with `workspace_store`** (or its `home_dir` fallback when the workspace itself is `home_dir`). Any path that escapes returns `TerminalError::CwdNotAllowed` — this prevents a misbehaving frontend bundle or malicious Tauri allowlist hole from launching a shell rooted at `/`. This is defense-in-depth on top of Tauri's command allowlist.

### 2.8 App shutdown

In `tauri::Builder::build().run`, register a `RunEvent::ExitRequested` handler: iterate `Registry.handles`, `child.kill()` each. Do **not** wait — the OS will reap.

---

## Section 3 — Frontend

### 3.1 File layout

```
packages/app/src/
├── stores/
│   └── terminal-store.ts                  # Zustand store (~250 LOC)
├── components/terminal/
│   ├── TerminalPanel.tsx                  # Bottom split shell (~200 LOC)
│   ├── TerminalTabBar.tsx                 # Tab strip with +/×/rename (~120 LOC)
│   ├── XtermInstance.tsx                  # Per-PTY mount/unmount (~180 LOC)
│   └── __tests__/                         # vitest
└── lib/
    └── terminal/
        ├── client.ts                      # Tauri invoke wrappers (~80 LOC)
        └── theme.ts                       # globals.css token → xterm theme (~60 LOC)
```

### 3.2 npm dependencies

```
@xterm/xterm
@xterm/addon-fit
@xterm/addon-web-links
```

`web-links` is included v1 so URLs in output are clickable; the addon is small (~3 KB).

### 3.3 Store shape (`terminal-store.ts`)

```ts
type TerminalTabId = string;  // matches Rust TerminalId

interface TerminalTab {
  id: TerminalTabId;
  workspaceId: string;
  title: string;            // default "zsh" / "bash" / "pwsh", user-renamable
  pid: number;
  shell: string;
  cwd: string;              // initial only; not tracked
  status: "running" | "exited";
  exitCode?: number;
  exitedAt?: number;        // ms epoch
}

interface TerminalState {
  tabsByWorkspace: Record<string, TerminalTab[]>;
  activeTabByWorkspace: Record<string, TerminalTabId | null>;
  panelOpenByWorkspace: Record<string, boolean>;
  panelHeightByWorkspace: Record<string, number>;   // px, localStorage
}

interface TerminalActions {
  openTerminal(workspaceId: string, opts?: { shell?: string; cwd?: string }): Promise<void>;
  closeTerminal(id: TerminalTabId): Promise<void>;
  setActiveTab(workspaceId: string, id: TerminalTabId): void;
  renameTab(id: TerminalTabId, title: string): void;
  togglePanel(workspaceId: string): void;
  setPanelHeight(workspaceId: string, px: number): void;
  hydrateForWorkspace(workspaceId: string): Promise<void>;
}
```

**xterm.js instances are NOT in the store.** `Terminal` objects hold DOM refs and event emitters; serializing them through Zustand breaks HMR and devtools. `XtermInstance` owns its `Terminal` in `useRef` for the lifetime of the component.

### 3.4 XtermInstance lifecycle

The store's `openTerminal` is responsible for the **one-time** `terminal_open` invoke and writes the returned `id` into `tab.id` before `XtermInstance` mounts. `XtermInstance` therefore always receives a `tab` with a live Rust-side id and always calls `terminal_subscribe` (never `terminal_open`) — this keeps the component idempotent across remount, tab-switch, and workspace-switch.

```
store.openTerminal(workspaceId):                     // happens before mount
  { id, shell, pid } = await invoke('terminal_open', { workspace_id, cwd, cols: 80, rows: 24 })
  store.appendTab(workspaceId, { id, shell, pid, status: "running", ... })

XtermInstance mount (id is now guaranteed live):
  1. new Terminal({ theme, fontFamily, fontSize, allowProposedApi: true })
  2. loadAddon(FitAddon); loadAddon(WebLinksAddon)
  3. terminal.open(divRef.current)
  4. fitAddon.fit() → { cols, rows }
  5. { ring_snapshot } = await invoke('terminal_subscribe', { id })
     terminal.write(ring_snapshot)                   // replay scrollback
     await invoke('terminal_resize', { id, cols, rows })   // size to current viewport
  6. unlistenData = await listen(`terminal://${id}/data`,  e => terminal.write(e.payload))
  7. unlistenExit = await listen(`terminal://${id}/exit`,  e => store.markExited(id, e.payload))
  8. terminal.onData(d => invoke('terminal_write',  { id, data: encode(d) }))
  9. terminal.onResize(({ cols, rows }) => invoke('terminal_resize', { id, cols, rows }))

unmount:
  1. unlistenData(); unlistenExit()
  2. terminal.dispose()
  3. DO NOT invoke('terminal_close')  ← Rust PTY stays alive
```

**Initial cols/rows in `openTerminal`.** The store doesn't know viewport size at openTerminal time (the component hasn't measured yet), so we spawn with a sensible default of `{ cols: 80, rows: 24 }`. `XtermInstance` immediately resizes to its actual measurement in step 5 above; any output written before resize is reflowed by xterm's scrollback engine. Cost: a few hundred bytes of initial prompt rendered at the wrong width, never visible to the user because the resize lands before the first paint.

### 3.5 ChatPanel integration

Current ChatPanel column (`packages/app/src/components/chat/ChatPanel.tsx`) is a `flex flex-col`. Insert `<TerminalPanel>` below the input area:

```tsx
<ChatPanel>
  <MessagesScrollArea />             {/* flex-1 */}
  <ChatInputArea />                  {/* shrink-0 */}
  {panelOpen && (
    <TerminalPanel
      workspaceId={...}
      heightPx={panelHeight}
      onResize={setPanelHeight}
    />
  )}
</ChatPanel>
```

Default `panelHeight` = 35% of the parent column height on first open, then user-controlled.

### 3.6 Drag-resize splitter

The top edge of `TerminalPanel` is a 4 px `cursor-row-resize` strip. Drag updates `panelHeight`, clamped to `[120, parentHeight - 200]`. On `mouseup`, persist to `localStorage` under key `teamclaw.terminal.height.{workspaceId}`.

### 3.7 UI entry point

In `packages/app/src/App.tsx` at line 1503 (immediately after the `AppWindow` icon for hide/restore file tabs), insert:

```tsx
{showWorkspaceContext && (
  <button
    className={cn(
      "rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
      isTerminalOpen ? "text-foreground bg-muted" : "text-muted-foreground"
    )}
    onClick={() => terminalStore.togglePanel(currentWorkspaceId)}
    title={t("terminal.toggle", "Toggle terminal (⌃`)")}
  >
    <TerminalSquare className="h-4 w-4" />
  </button>
)}
```

**The terminal is NOT a `RightPanelTab`.** It does not extend the `RightPanelTab` union (`"diff" | "files" | "shortcuts" | "knowledge" | "actors"`). Terminal occupies ChatPanel bottom; Actors/Knowledge/Changes occupy the right panel. They are orthogonal surfaces and can be open simultaneously.

### 3.8 Keyboard shortcuts

Registered in `useGlobalShortcuts`:

| Shortcut | Action | Scope |
|---|---|---|
| `⌃` + `` ` `` | `togglePanel(currentWorkspaceId)` | Global, always |
| `⌘ + T` | `openTerminal(currentWorkspaceId)` | Only when terminal is focused |
| `⌘ + W` | `closeTerminal(activeTabId)` | Only when terminal is focused; falls through to default `⌘ + W` otherwise |
| `⌘ + ⇧ + [` / `]` | Previous / next tab | Only when terminal is focused |

### 3.9 Theme bridge (`lib/terminal/theme.ts`)

xterm.js accepts a `theme` prop with keys like `background`, `foreground`, `cursor`, `selectionBackground`, plus 16 ANSI slots. We read CSS custom properties from `:root` via `getComputedStyle(document.documentElement)`:

| xterm key | CSS token |
|---|---|
| `background` | `--background` |
| `foreground` | `--foreground` |
| `cursor` | `--coral` |
| `selectionBackground` | `--selected` |
| ANSI 0–15 | xterm defaults (don't fight terminal apps that color themselves) |

Font: `--font-mono` first family (JetBrains Mono), 12 px, line-height 1.4. Theme is rebuilt and reapplied (`terminal.options.theme = newTheme`) when the theme-mode store toggles dark/light.

### 3.10 i18n

New namespace `terminal.*` in `packages/app/src/locales/en.json` and `zh-CN.json`:

- `terminal.toggle` — "Toggle terminal (⌃`)" / "切换终端 (⌃`)"
- `terminal.newTab` — "New terminal" / "新建终端"
- `terminal.closeTab` — "Close terminal" / "关闭终端"
- `terminal.rename` — "Rename" / "重命名"
- `terminal.exited` — "Process exited (code {{code}}) — press Enter to restart" / "进程已退出 (code {{code}}) — 按 Enter 重启"
- `terminal.spawnFailed` — "Failed to start shell: {{message}}" / "启动 shell 失败:{{message}}"
- `terminal.cwdFallback` — "Workspace cwd unavailable, using home directory" / "workspace 路径不可用,已回退到 home"

Tab titles (`zsh` / `bash` / `pwsh`) are not translated.

---

## Section 4 — Data Flow & Lifecycle

### 4.1 First open (cold)

```
User: ⌃` or clicks TerminalSquare icon
  ↓
terminalStore.togglePanel(workspaceId)
  panelOpen = true
  if no tabs for workspace → openTerminal(workspaceId)
  ↓
invoke('terminal_open', { workspace_id, cwd: workspace.path, cols, rows })
  ↓
Rust:
  portable_pty::native_pty_system().openpty(PtySize)
  pair.slave.spawn_command(CommandBuilder::new($SHELL).args(["-l"]))
  start reader thread, init 8 MiB RingBuffer
  Registry.insert(id, Arc<PtyHandle>)
  return { id, shell, pid }
  ↓
Frontend:
  store.appendTab(workspaceId, { id, shell, pid, status: "running", ... })
  XtermInstance mounts, attaches listeners
```

### 4.2 Workspace switch round trip

```
Switch away:
  ChatPanel unmounts → TerminalPanel unmounts → XtermInstance unmount
  unlisten + terminal.dispose()
  Rust PTYs continue running; ring buffer continues filling

Switch back:
  TerminalPanel mounts
  terminalStore.hydrateForWorkspace(newWorkspaceId)
    → invoke('terminal_list', { workspace_id })
    → reconcile store.tabsByWorkspace
  XtermInstance mounts with existing id
    → invoke('terminal_subscribe', { id })
    → terminal.write(ring_snapshot)
    → re-listen `terminal://{id}/data` for new bytes
```

### 4.3 PTY exit

```
Shell exits (user types `exit` / Ctrl+D / external kill):
  reader read() → 0 bytes
  emit `terminal://{id}/exit` { code, signal }
  ↓
Frontend:
  store.markExited(id, { code })
  Tab title goes muted, label appended " (exited)"
  Buffer shows "terminal.exited" toast at bottom of xterm view
  Pressing Enter while focused on an exited tab:
    → closeTerminal(id) + openTerminal(workspaceId, { cwd, shell })
    → new tab takes the same UI slot, ring buffer starts fresh
```

### 4.4 App exit

```
Tauri RunEvent::ExitRequested:
  Registry.handles.iter().for_each(|(_, h)| { let _ = h.child.lock().kill(); });
  No wait — OS reaps zombies.
```

---

## Section 5 — Error Handling

| Error | Trigger | Handling |
|---|---|---|
| `ShellNotFound` | `$SHELL` doesn't exist | Fall back to `/bin/zsh` → `/bin/bash` → `powershell.exe`. If all fail, return error; frontend shows `terminal.spawnFailed` toast. |
| `CwdNotAllowed` | `terminal_open` cwd escapes workspace | Reject, frontend toasts and reopens with `home_dir`. |
| `CwdNotFound` | cwd path does not exist | Fall back to `home_dir`; emit `terminal.cwdFallback` toast. |
| `PtyClosed` | Write after exit | Frontend ignores; Enter-to-restart path handles user intent. |
| Reader thread panic | Should not occur | `catch_unwind`: emit synthetic `exit { code: -1 }`, remove handle. |
| Ring buffer full | `yes`-style high-throughput output | Overwrites oldest bytes silently. Matches VS Code behavior. |
| Tauri channel saturation | `cat /dev/urandom` | Reader drops emit frame, keeps reading. Documented limitation. |
| App close mid-write | User closes app while shell is writing | Children killed; lost output is acceptable. |

### 5.1 Security posture

The terminal is the user running their own shell — **no new permission boundary**. It is equivalent to opening Terminal.app side-by-side with TeamClaw, and is explicitly **not** routed through the ACP permission flow (no `AcpPermissionRequest` envelopes).

The only added defense is `CwdNotAllowed` cwd validation in §2.7, which prevents a hypothetical compromised frontend from spawning a shell rooted outside the user's registered workspaces. This is defense-in-depth on top of Tauri's command allowlist.

---

## Section 6 — Testing

| Layer | Tool | Coverage |
|---|---|---|
| Rust unit | `cargo test` + `tempdir` | `Registry::insert` / `remove`; `RingBuffer::write_overwrite` wrap-around; `RingBuffer::snapshot` ordering; cwd validation; shell fallback chain. |
| Rust integration | `cargo test` + real PTY | Spawn `echo hello`, read `hello\n` from event stream; spawn `cat`, write `foo\n`, read `foo\n` echo; spawn `false`, expect `exit { code: 1 }`. |
| Frontend store | vitest | `openTerminal` → tab inserted; `closeTerminal` → tab removed; `togglePanel` flip; `renameTab` updates title; `hydrateForWorkspace` reconciles. |
| Frontend component | vitest + jsdom | `XtermInstance` mount holds ref; unmount calls `terminal.dispose` but **not** `terminal_close`; listener cleanup on unmount; theme rebuild on dark/light toggle. |
| E2E smoke | tauri-mcp (`tests/e2e/`) | 1) Click TerminalSquare icon → panel appears with one tab. 2) Type `pwd` + Enter → output contains workspace path. 3) Switch workspace and back → ring replay preserves `pwd` output. 4) `exit` → tab marked exited. |

**E2E coverage is macOS-only** in v1, consistent with [[amuxd-architecture-design]] Q6. Linux runners can run the Rust unit + integration layers; the E2E gate stays Mac-gated until we verify ConPTY behavior on Windows.

---

## Section 7 — Open Questions Deferred to v2+

These are intentionally **out of scope** but flagged so the design space is documented:

- **"Run this in terminal" from chat code blocks.** Pre-fill PTY input with selected command, don't auto-Enter. Currently rejected to keep terminal purely human-driven (Q7); reconsider once usage data shows demand.
- **"Send selection to agent" from terminal.** Right-click in xterm → adds selection as a `ChatMessage` context block in the active session input. Same gating as above.
- **Per-session terminals.** Currently scoped to workspace. If multi-session inside one workspace becomes a common debugging pattern, switch to per-session bucketing.
- **Cross-restart persistence.** Requires daemonizing PTYs into a separate process and adding a reattach protocol. Big lift; out of scope for v2.0.
- **Profiles / startup commands.** "On open, run `pnpm dev`" would let TeamClaw replace devcontainer terminals. Wait until v1 shipped.
- **In-terminal search.** xterm.js has `search` addon (~10 KB). Add when users ask.

---

## Implementation Estimate

| Surface | LOC | Risk |
|---|---|---|
| Rust `terminal/registry.rs` + `pty.rs` | ~270 | Low — portable-pty is well-trodden |
| Rust `commands/terminal.rs` | ~150 | Low |
| Frontend `terminal-store.ts` | ~250 | Low |
| Frontend `TerminalPanel` + `TabBar` + `XtermInstance` | ~500 | Medium — xterm.js lifecycle / resize / theme rebuild gotchas |
| Frontend `lib/terminal/` | ~140 | Low |
| ChatPanel + App.tsx integration | ~80 | Low |
| Tests (Rust + frontend + E2E) | ~600 | Medium |
| i18n | ~30 | Trivial |
| **Total** | **~2020** | **Medium** |

Single implementation plan can ship this end-to-end. No phased rollout needed; the subsystem is internally self-contained and externally inert (zero existing-feature risk).

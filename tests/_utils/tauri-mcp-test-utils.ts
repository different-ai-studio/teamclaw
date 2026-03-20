/**
 * Tauri-mcp Test Utilities
 *
 * Launches the TeamClaw app directly via process spawn, and uses tauri-mcp
 * MCP server for window queries, keyboard/mouse input, and JS execution.
 * Run from repo root: TEAMCLAW_APP_PATH defaults to src-tauri/target/debug/teamclaw.
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { createConnection, type Socket } from 'net';

const TEAMCLAW_APP_PATH =
  process.env.TEAMCLAW_APP_PATH ||
  join(process.cwd(), 'src-tauri/target/debug/teamclaw');

const TAURI_MCP_SOCKET =
  process.env.TAURI_MCP_SOCKET || '/tmp/tauri-mcp.sock';

let _processId: string | null = null;
let _osPid: number | null = null;
let _appProcess: ChildProcess | null = null;
let _ownedProcess = false; // true if we spawned the process ourselves

// ── Socket client for tauri-plugin-mcp ────────────────────────────────
// Connects to the Unix domain socket exposed by the tauri-plugin-mcp
// Rust plugin in debug builds. Protocol: newline-delimited JSON.
// Request:  {"command":"<tool>","payload":{...}}
// Response: {"success":bool,"data":...,"error":...}

function socketCall(command: string, payload: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    let client: Socket;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client?.destroy();
        reject(new Error(`Socket call '${command}' timed out after 15s`));
      }
    }, 15_000);

    try {
      client = createConnection(TAURI_MCP_SOCKET);
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`Failed to connect to socket ${TAURI_MCP_SOCKET}: ${err}`));
      return;
    }

    client.on('connect', () => {
      const msg = JSON.stringify({ command, payload }) + '\n';
      client.write(msg);
    });

    client.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Look for a complete JSON line
      const idx = buffer.indexOf('\n');
      const line = idx !== -1 ? buffer.slice(0, idx) : buffer;
      // Try to parse — the response may arrive without a trailing newline
      try {
        const resp = JSON.parse(line.trim());
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          client.end();
          if (resp.success) {
            resolve(resp.data);
          } else {
            reject(new Error(resp.error || 'Unknown socket error'));
          }
        }
      } catch {
        // Not complete JSON yet, wait for more data
      }
    });

    client.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Socket error: ${err.message}`));
      }
    });

    client.on('close', () => {
      if (!settled) {
        // Try to parse whatever we have
        try {
          const resp = JSON.parse(buffer.trim());
          settled = true;
          clearTimeout(timer);
          if (resp.success) {
            resolve(resp.data);
          } else {
            reject(new Error(resp.error || 'Unknown socket error'));
          }
        } catch {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Socket closed without valid response. Buffer: ${buffer.slice(0, 200)}`));
        }
      }
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────

export function getProcessId(): string {
  if (!_processId) throw new Error('App not launched yet – call launchTeamClawApp first');
  return _processId;
}
export function getOsPid(): number {
  if (!_osPid) throw new Error('App not launched yet – call launchTeamClawApp first');
  return _osPid;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function exec(cmd: string, maxBuffer = 10 * 1024 * 1024): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer,
  }).trim();
}

/**
 * Try to ping the socket to see if an app is already running.
 */
async function isSocketAlive(): Promise<boolean> {
  try {
    await socketCall('ping', {});
    return true;
  } catch {
    return false;
  }
}

export async function launchTeamClawApp(): Promise<string> {
  // If the socket is already alive, reuse the running app (e.g. pnpm tauri dev)
  if (existsSync(TAURI_MCP_SOCKET) && await isSocketAlive()) {
    console.log('[test-utils] Existing app detected via socket, reusing it');
    // Find the PID of the running teamclaw process
    try {
      const pid = exec('pgrep -f "target/debug/teamclaw" | head -1');
      if (pid) {
        _osPid = parseInt(pid);
        _processId = String(_osPid);
        _ownedProcess = false;
        return _processId;
      }
    } catch { /* fall through to spawn */ }
  }

  if (!existsSync(TEAMCLAW_APP_PATH)) {
    throw new Error(
      `TeamClaw binary not found at ${TEAMCLAW_APP_PATH}. Run: pnpm tauri:build`,
    );
  }

  // Kill any existing teamclaw processes (only when we need to spawn our own)
  try { exec('pkill -f "target/debug/teamclaw" 2>/dev/null || true'); } catch { /* ok */ }
  await sleep(1000);

  // Clean up stale socket file
  try { exec(`rm -f ${TAURI_MCP_SOCKET}`); } catch { /* ok */ }

  // Launch app directly as a child process
  _appProcess = spawn(TEAMCLAW_APP_PATH, [], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  _osPid = _appProcess.pid || null;
  _processId = _osPid ? String(_osPid) : null;
  _ownedProcess = true;

  _appProcess.stdout?.on('data', () => { /* suppress */ });
  _appProcess.stderr?.on('data', () => { /* suppress */ });
  _appProcess.unref();

  if (!_osPid) {
    throw new Error('Failed to get PID from spawned app');
  }

  // Wait for socket to appear
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    if (existsSync(TAURI_MCP_SOCKET) && await isSocketAlive()) {
      console.log(`[test-utils] Socket ready after ${(i + 1) * 2}s`);
      break;
    }
  }

  return _processId!;
}

export async function stopApp(): Promise<void> {
  // Only kill the app if we spawned it ourselves
  if (_ownedProcess) {
    if (_appProcess) {
      try { _appProcess.kill(); } catch { /* ok */ }
      _appProcess = null;
    }
    if (_osPid) {
      try { exec(`kill ${_osPid} 2>/dev/null || true`); } catch { /* ok */ }
      try { exec('pkill -f "target/debug/teamclaw" 2>/dev/null || true'); } catch { /* ok */ }
    }
  } else {
    console.log('[test-utils] Skipping app shutdown (reusing existing app)');
  }
  _processId = null;
  _osPid = null;
  _ownedProcess = false;
}

export interface WindowInfo {
  width: number;
  height: number;
  x: number;
  y: number;
  isVisible: boolean;
  isFocused: boolean;
}

export async function getWindowInfo(): Promise<WindowInfo> {
  if (!_osPid) {
    return { width: 1200, height: 800, x: 0, y: 0, isVisible: true, isFocused: false };
  }
  // Use AppleScript to query main window info
  try {
    const script = `tell application "System Events"
  set p to first process whose unix id is ${_osPid}
  tell p
    set w to first window
    set {x, y} to position of w
    set {width, height} to size of w
    set vis to visible of w
    set foc to focused of w
    return (x as string) & "," & (y as string) & "," & (width as string) & "," & (height as string) & "," & (vis as string) & "," & (foc as string)
  end tell
end tell`;
    const raw = exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    const parts = raw.split(',');
    return {
      x: parseInt(parts[0]) || 0,
      y: parseInt(parts[1]) || 0,
      width: parseInt(parts[2]) || 0,
      height: parseInt(parts[3]) || 0,
      isVisible: parts[4]?.trim() === 'true',
      isFocused: parts[5]?.trim() === 'true',
    };
  } catch {
    return { width: 1200, height: 800, x: 0, y: 0, isVisible: true, isFocused: false };
  }
}

export async function focusWindow(): Promise<void> {
  const pid = _osPid;
  if (!pid) return;
  try {
    exec(
      `osascript -e 'tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true'`,
    );
  } catch (e: unknown) {
    console.warn(`focusWindow: ${(e as Error).message}`);
  }
}

export async function takeScreenshot(savePath?: string): Promise<string> {
  const dest = savePath || `/tmp/teamclaw-test-${Date.now()}.png`;
  try {
    const w = await getWindowInfo();
    exec(`screencapture -x -R${w.x},${w.y},${w.width},${w.height} ${dest}`);
    return dest;
  } catch {
    // Fallback: full screen capture
    exec(`screencapture -x ${dest}`);
    return dest;
  }
}

export async function sendKeys(
  keys: string,
  modifiers: string[] = [],
): Promise<void> {
  const pid = _osPid;
  if (!pid) return;

  // Map key names to AppleScript key codes
  const keyCodeMap: Record<string, number> = {
    'Return': 36, 'Enter': 36,
    'Escape': 53,
    'Space': 49,
    'Tab': 48,
    'Delete': 51,
    'w': 13, 'W': 13,
    '\\': 42,
  };

  // Map modifiers to AppleScript
  const modMap: Record<string, string> = {
    'meta': 'command down',
    'alt': 'option down',
    'shift': 'shift down',
    'ctrl': 'control down',
  };

  const modStr = modifiers.map(m => modMap[m] || `${m} down`).filter(Boolean);
  const usingClause = modStr.length > 0 ? ` using {${modStr.join(', ')}}` : '';

  const keyCode = keyCodeMap[keys];

  let script: string;
  if (keyCode !== undefined) {
    script = `tell application "System Events"
  set p to first process whose unix id is ${pid}
  set frontmost of p to true
  delay 0.1
  key code ${keyCode}${usingClause}
end tell`;
  } else {
    // Type text characters
    script = `tell application "System Events"
  set p to first process whose unix id is ${pid}
  set frontmost of p to true
  delay 0.1
  keystroke "${keys}"${usingClause}
end tell`;
  }

  try {
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
  } catch (e: unknown) {
    console.warn(`sendKeys(${keys}): ${(e as Error).message}`);
  }
}

export async function mouseClick(x: number, y: number): Promise<void> {
  try {
    exec(`osascript -e '
tell application "System Events"
  click at {${x}, ${y}}
end tell'`);
  } catch {
    // Fallback: use cliclick if available
    try {
      exec(`cliclick c:${x},${y}`);
    } catch {
      console.warn(`mouseClick(${x},${y}): both methods failed`);
    }
  }
}

/**
 * Execute JavaScript in the app's webview via tauri-plugin-mcp socket.
 */
export async function executeJs(code: string): Promise<string> {
  const data = await socketCall('execute_js', { code });
  // data is { result: string, type: string } on success
  if (data && typeof data === 'object' && 'result' in data) {
    return data.result;
  }
  return typeof data === 'string' ? data : JSON.stringify(data);
}

function osascript(body: string): string {
  const pid = _osPid;
  if (!pid) throw new Error('No OS PID – app not launched');
  const script = `tell application "System Events"
  set p to first process whose unix id is ${pid}
  tell p
    tell window "TeamClaw"
      ${body}
    end tell
  end tell
end tell`;
  return exec(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`);
}

export async function clickFileInTree(filename: string): Promise<void> {
  osascript(
    `set btn to first button of UI element 1 of scroll area 1 of group 1 of group 1 whose name contains "${filename}"
click btn`,
  );
}

export async function switchToCodeSpace(): Promise<void> {
  await focusWindow();
  await sleep(300);
  await sendKeys('\\', ['meta']);
  await sleep(800);
}

/**
 * Call a Tauri IPC command via tauri-plugin-mcp socket.
 */
export async function callIpcCommand(
  commandName: string,
  args?: Record<string, unknown>,
): Promise<string> {
  const data = await socketCall('call_ipc_command', {
    command_name: commandName,
    ...(args ? { args } : {}),
  });
  return typeof data === 'string' ? data : JSON.stringify(data);
}

// ── Polling Helper ───────────────────────────────────────────────────

/**
 * Poll an executeJs expression until the predicate passes or timeout.
 */
export async function waitForCondition(
  jsCode: string,
  predicate: (result: string) => boolean = (r) => r !== '' && r !== 'null' && r !== 'false',
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await executeJs(jsCode);
    if (predicate(result)) {
      return result;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms: ${jsCode}`);
}

// ── Video Recording ──────────────────────────────────────────────────

let _videoProcess: ChildProcess | null = null;
let _videoPath: string | null = null;

/**
 * Start recording video of the app window using macOS screencapture.
 * Returns the output file path.
 */
export async function startVideoRecording(savePath?: string): Promise<string> {
  if (_videoProcess) {
    throw new Error('Video recording already in progress');
  }

  const dest = savePath || `/tmp/teamclaw-test-${Date.now()}.mov`;
  _videoPath = dest;

  const w = await getWindowInfo();

  // macOS screencapture -v records video, -R captures a region
  _videoProcess = spawn('screencapture', [
    '-v',
    `-R${w.x},${w.y},${w.width},${w.height}`,
    dest,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  _videoProcess.on('close', () => {
    _videoProcess = null;
  });

  // Give screencapture a moment to start
  await sleep(500);

  return dest;
}

/**
 * Stop the current video recording. Returns the file path of the recording.
 */
export async function stopVideoRecording(): Promise<string | null> {
  if (!_videoProcess) {
    return _videoPath;
  }

  const path = _videoPath;

  // screencapture stops recording on SIGINT
  _videoProcess.kill('SIGINT');

  // Wait for the process to finish writing
  await new Promise<void>((resolve) => {
    if (!_videoProcess) {
      resolve();
      return;
    }
    _videoProcess.on('close', () => resolve());
    setTimeout(resolve, 3000); // safety timeout
  });

  _videoProcess = null;
  _videoPath = null;

  return path;
}

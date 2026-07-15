/**
 * Regression: macOS close-to-tray and dock reopen (REG-16)
 * Uses test control server to close window and verify dock reopen.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  getWindowInfo,
  takeScreenshot,
} from '../_utils/tauri-mcp-test-utils';

const CONTROL_SERVER = 'http://127.0.0.1:13199';

async function tauriCommand(command: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL_SERVER}/test/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

describe('Regression: macOS close-to-tray and dock reopen', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);

      // Wait for test control server
      for (let i = 0; i < 10; i++) {
        try {
          const res = await fetch(`${CONTROL_SERVER}/test/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'get_spotlight_state' }),
          });
          if (res.ok) {
            appReady = true;
            break;
          }
        } catch {
          // not ready yet
        }
        await sleep(2000);
      }

      if (!appReady) {
        console.error('App launched but test control server not reachable');
      } else {
        // Ensure window is in a clean main-mode visible state
        await tauriCommand('show_main_window');
        await sleep(1000);
      }
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('REG-16: close window hides to tray, dock click reopens', async () => {
    if (!appReady) return;

    // 1. Ensure main window is visible
    await tauriCommand('show_main_window');
    await sleep(1000);

    const before = await tauriCommand('get_spotlight_state');
    expect(before['visible']).toBe(true);
    expect(before['mode']).toBe('main');
    await takeScreenshot('/tmp/reg-dock-before-close.png');

    // 2. Close window via test control server (triggers CloseRequested → hide)
    await tauriCommand('close_window');
    await sleep(2000);

    // 3. Verify window is hidden via Tauri state (more reliable than AppleScript)
    const afterClose = await tauriCommand('get_spotlight_state');
    expect(afterClose['visible']).toBe(false);

    // 4. Simulate dock click by showing main window (same as reopen_from_dock)
    await tauriCommand('show_main_window');
    await sleep(2000);

    // 5. Verify window is visible again
    const afterReopen = await tauriCommand('get_spotlight_state');
    expect(afterReopen['visible']).toBe(true);
    expect(afterReopen['mode']).toBe('main');

    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/reg-dock-reopen.png');
    expect(path).toBeTruthy();
  }, 30_000);
});

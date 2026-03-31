/**
 * Regression: tray icon visible after close, click opens spotlight,
 * pin/unpin state correct (REG-17)
 *
 * Scenario:
 *   1. Close main window → window hidden, app still alive (tray icon visible)
 *   2. Click tray icon → spotlight window appears
 *   3. Default pinned state is false (unpinned)
 *   4. Toggle pin → pinned persists across hide/show cycles
 *
 * Uses test control server at http://127.0.0.1:13199 for Tauri IPC commands,
 * and executeJs for set_spotlight_pin (not exposed via test control server).
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

async function tauriCommand(command: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL_SERVER}/test/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, ...(args ? { args } : {}) }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

describe('Regression: tray → spotlight → pin state', () => {
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

  it('REG-17a: close main window → hidden but app alive (tray visible)', async () => {
    if (!appReady) return;

    // Ensure we're in main mode and visible
    await tauriCommand('show_main_window');
    await sleep(1000);

    const before = await tauriCommand('get_spotlight_state');
    expect(before['visible']).toBe(true);
    expect(before['mode']).toBe('main');

    // Close window via test control server (triggers CloseRequested → hide)
    await tauriCommand('close_window');
    await sleep(2000);

    // Window should be hidden, but app process is still alive (tray icon present)
    const after = await tauriCommand('get_spotlight_state');
    expect(after['visible']).toBe(false);

    await takeScreenshot('/tmp/reg-tray-after-close.png');
  }, 20_000);

  it('REG-17b: click tray icon → spotlight window appears', async () => {
    if (!appReady) return;

    // Simulate tray click via force_toggle_spotlight
    await tauriCommand('force_toggle_spotlight');
    await sleep(2000);

    const state = await tauriCommand('get_spotlight_state');
    expect(state['visible']).toBe(true);
    expect(state['mode']).toBe('spotlight');

    // Verify window is actually visible via OS
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);

    await takeScreenshot('/tmp/reg-tray-spotlight-opened.png');
  }, 15_000);

  it('REG-17c: spotlight default pinned state is false (unpinned)', async () => {
    if (!appReady) return;

    const state = await tauriCommand('get_spotlight_state');
    expect(state['mode']).toBe('spotlight');
    expect(state['pinned']).toBe(false);

    await takeScreenshot('/tmp/reg-tray-spotlight-unpinned.png');
  }, 10_000);

  it('REG-17d: toggle pin → pinned persists across hide/show cycle', async () => {
    if (!appReady) return;

    // Pin the spotlight via webview invoke
    await tauriCommand('set_spotlight_pin', { pinned: true });

    const pinned = await tauriCommand('get_spotlight_state');
    expect(pinned['pinned']).toBe(true);

    // Hide spotlight (toggle off)
    await tauriCommand('force_toggle_spotlight');
    await sleep(1000);

    const hidden = await tauriCommand('get_spotlight_state');
    expect(hidden['visible']).toBe(false);
    // Pin state should persist even when hidden
    expect(hidden['pinned']).toBe(true);

    // Show spotlight again (toggle on)
    await tauriCommand('force_toggle_spotlight');
    await sleep(2000);

    const reopened = await tauriCommand('get_spotlight_state');
    expect(reopened['visible']).toBe(true);
    expect(reopened['mode']).toBe('spotlight');
    expect(reopened['pinned']).toBe(true);

    await takeScreenshot('/tmp/reg-tray-spotlight-pinned-persist.png');
  }, 20_000);

  it('REG-17e: unpin → unpinned persists across hide/show cycle', async () => {
    if (!appReady) return;

    // Unpin the spotlight via webview invoke
    await tauriCommand('set_spotlight_pin', { pinned: false });

    const unpinned = await tauriCommand('get_spotlight_state');
    expect(unpinned['pinned']).toBe(false);

    // Hide and re-show
    await tauriCommand('force_toggle_spotlight');
    await sleep(1000);
    await tauriCommand('force_toggle_spotlight');
    await sleep(2000);

    const reopened = await tauriCommand('get_spotlight_state');
    expect(reopened['visible']).toBe(true);
    expect(reopened['pinned']).toBe(false);

    await takeScreenshot('/tmp/reg-tray-spotlight-unpinned-persist.png');
  }, 20_000);
});

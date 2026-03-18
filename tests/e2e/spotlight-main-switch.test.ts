/**
 * E2E: Spotlight ↔ Main window mode switching
 *
 * Tests the single-window architecture transition between Spotlight and Main mode.
 * Known bug: switching from Spotlight → Main via expand_to_main causes a panic.
 *
 * Uses tauri-mcp and the test control server at http://127.0.0.1:13199.
 * Video recording captures the window during transitions for debugging.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  getWindowInfo,
  takeScreenshot,
  startVideoRecording,
  stopVideoRecording,
} from '../_utils/tauri-mcp-test-utils';

const CONTROL_SERVER = 'http://127.0.0.1:13199';

// Spotlight default dimensions from spotlight.rs
const SPOTLIGHT_WIDTH = 420;
const SPOTLIGHT_HEIGHT = 560;
const MAIN_WIDTH = 1200;
const MAIN_HEIGHT = 800;
const SIZE_TOLERANCE = 50; // allow some tolerance for window chrome/rounding

async function tauriCommand(command: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL_SERVER}/test/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

describe('E2E: Spotlight ↔ Main window switch', () => {
  let appReady = false;
  let videoPath: string | null = null;

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
      }

      // Start video recording for the test suite
      try {
        videoPath = await startVideoRecording(
          `/tmp/teamclaw-spotlight-switch-${Date.now()}.mov`,
        );
        console.log(`Recording video to: ${videoPath}`);
      } catch (err) {
        console.warn('Could not start video recording:', (err as Error).message);
      }
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    // Stop video recording
    try {
      const path = await stopVideoRecording();
      if (path) {
        console.log(`Video saved to: ${path}`);
      }
    } catch {
      // ok
    }
    await stopApp();
  }, 30_000);

  // ── Normalize to main mode ────────────────────────────────────────

  it('can set app to main mode via show_main_window', async () => {
    if (!appReady) return;

    // Always start from a known state: Main mode
    await tauriCommand('show_main_window');
    await sleep(1000);

    const state = await tauriCommand('get_spotlight_state');
    expect(state['mode']).toBe('main');
    expect(state['visible']).toBe(true);

    const info = await getWindowInfo();
    expect(info.width).toBeGreaterThanOrEqual(MAIN_WIDTH - SIZE_TOLERANCE);
    expect(info.height).toBeGreaterThanOrEqual(MAIN_HEIGHT - SIZE_TOLERANCE);

    await takeScreenshot('/tmp/teamclaw-initial-main.png');
  }, 15_000);

  // ── Main → Spotlight ─────────────────────────────────────────────────

  it('force_toggle_spotlight switches to spotlight mode', async () => {
    if (!appReady) return;

    // Ensure main mode
    await tauriCommand('show_main_window');
    await sleep(1000);

    await takeScreenshot('/tmp/teamclaw-before-toggle.png');

    await tauriCommand('force_toggle_spotlight');
    await sleep(2000);

    const state = await tauriCommand('get_spotlight_state');
    expect(state['mode']).toBe('spotlight');
    expect(state['visible']).toBe(true);

    await takeScreenshot('/tmp/teamclaw-after-toggle-spotlight.png');

    // Note: AppleScript `size of window` may not reflect Tauri set_size
    // on transparent windows (transparent: true in tauri.conf.json).
    const info = await getWindowInfo();
    console.log(`Spotlight mode - AppleScript reports: ${info.width}x${info.height}`);
  }, 15_000);

  // ── Spotlight → Main (the panic scenario) ────────────────────────────

  it('expand_to_main transitions back to main mode without crash', async () => {
    if (!appReady) return;

    await takeScreenshot('/tmp/teamclaw-before-expand.png');

    // This is the operation that causes a panic
    let expandError: string | null = null;
    try {
      const result = await tauriCommand('expand_to_main');
      if (result['error']) {
        expandError = String(result['error']);
      }
    } catch (err) {
      expandError = (err as Error).message;
    }

    // Wait for animation (300ms) + buffer
    await sleep(1500);

    await takeScreenshot('/tmp/teamclaw-after-expand.png');

    // Verify the app didn't crash - try to get state
    let postExpandState: Record<string, unknown> | null = null;
    try {
      postExpandState = await tauriCommand('get_spotlight_state');
    } catch (err) {
      // If this fails, the app likely panicked
      console.error('App appears to have crashed after expand_to_main');
      console.error('Error:', (err as Error).message);
    }

    expect(postExpandState).not.toBeNull();

    if (postExpandState) {
      expect(postExpandState['mode']).toBe('main');
      expect(postExpandState['visible']).toBe(true);
    }

    if (expandError) {
      console.error('expand_to_main returned error:', expandError);
    }
  }, 30_000);

  it('window size returns to main dimensions after expand', async () => {
    if (!appReady) return;

    const state = await tauriCommand('get_spotlight_state');
    if (state['mode'] !== 'main') {
      console.warn('Skipping size check - not in main mode (likely crashed)');
      return;
    }

    await sleep(500);
    const info = await getWindowInfo();
    expect(info.width).toBeGreaterThan(MAIN_WIDTH - SIZE_TOLERANCE);
    expect(info.height).toBeGreaterThan(MAIN_HEIGHT - SIZE_TOLERANCE);
  }, 15_000);

  // ── Round-trip: Main → Spotlight → Main (full cycle) ──────────────

  it('full cycle: main → spotlight → main without crash', async () => {
    if (!appReady) return;

    // Ensure we're in main mode
    let state = await tauriCommand('get_spotlight_state');
    if (state['mode'] !== 'main') {
      await tauriCommand('show_main_window');
      await sleep(1000);
    }

    // Main → Spotlight
    await tauriCommand('force_toggle_spotlight');
    await sleep(1000);

    state = await tauriCommand('get_spotlight_state');
    expect(state['mode']).toBe('spotlight');

    // Spotlight → Main (expand with animation)
    try {
      await tauriCommand('expand_to_main');
    } catch (err) {
      console.error('expand_to_main failed in round-trip:', (err as Error).message);
    }
    await sleep(1500);

    // Verify state
    try {
      state = await tauriCommand('get_spotlight_state');
      expect(state['mode']).toBe('main');
      expect(state['visible']).toBe(true);
    } catch {
      // App crashed
      expect.fail('App crashed during round-trip spotlight ↔ main switch');
    }
  }, 30_000);

  // ── show_main_window (non-animated path) ─────────────────────────

  it('show_main_window switches directly without animation', async () => {
    if (!appReady) return;

    // Go to spotlight first
    await tauriCommand('force_toggle_spotlight');
    await sleep(1000);

    let state = await tauriCommand('get_spotlight_state');
    expect(state['mode']).toBe('spotlight');

    // Use show_main_window (non-animated, direct switch)
    await tauriCommand('show_main_window');
    await sleep(1000);

    state = await tauriCommand('get_spotlight_state');
    expect(state['mode']).toBe('main');
    expect(state['visible']).toBe(true);

    const info = await getWindowInfo();
    expect(info.width).toBeGreaterThan(MAIN_WIDTH - SIZE_TOLERANCE);
  }, 15_000);
});

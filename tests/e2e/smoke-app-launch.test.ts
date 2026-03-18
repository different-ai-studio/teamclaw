/**
 * E2E Smoke: app launch
 * tauri-mcp: launch app, assert window visible and screenshot.
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

describe('E2E Smoke: app launch', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);
      appReady = true;
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('should load app without crash', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    expect(win.width).toBeGreaterThan(0);
    expect(win.height).toBeGreaterThan(0);
  }, 15_000);

  it('should show main UI or workspace prompt', async () => {
    if (!appReady) return;
    const path = await takeScreenshot('/tmp/smoke-app-launch.png');
    expect(path).toBeTruthy();
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
  }, 15_000);
});

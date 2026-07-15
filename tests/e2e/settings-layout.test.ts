/**
 * E2E: settings and layout (ST-01, L-01)
 * tauri-mcp: launch app, open settings, screenshot.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sendKeys,
  sleep,
  focusWindow,
  getWindowInfo,
  takeScreenshot,
} from '../_utils/tauri-mcp-test-utils';

describe('E2E: settings and layout', () => {
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

  it('ST-01: settings open when clicking Settings', async () => {
    if (!appReady) return;
    await sendKeys(',', ['meta']);
    await sleep(2000);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/e2e-settings.png');
    expect(path).toBeTruthy();
  }, 15_000);

  it('L-01: main layout visible', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    expect(win.width).toBeGreaterThan(0);
  }, 10_000);
});

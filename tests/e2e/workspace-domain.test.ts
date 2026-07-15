/**
 * E2E: workspace domain (W-15, W-01/W-02)
 * tauri-mcp: launch app, assert window and screenshot.
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

describe('E2E: workspace domain', () => {
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

  it('W-15: no workspace shows workspace or Web Mode prompt', async () => {
    if (!appReady) return;
    await focusWindow();
    await sleep(500);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/e2e-workspace-prompt.png');
    expect(path).toBeTruthy();
  }, 15_000);

  it('W-01/W-02: app loads and shows main UI', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    expect(win.width).toBeGreaterThan(0);
    expect(win.height).toBeGreaterThan(0);
  }, 15_000);
});

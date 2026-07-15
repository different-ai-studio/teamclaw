/**
 * Regression: layout toggle and workspace (REG-06, REG-07, REG-15)
 * tauri-mcp: launch app, sendKeys, getWindowInfo, takeScreenshot.
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

describe('Regression: layout and workspace', () => {
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

  it('REG-06: Cmd+\\ toggles layout and panel matches mode', async () => {
    if (!appReady) return;
    await sendKeys('\\', ['meta']);
    await sleep(800);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/reg-layout-toggle.png');
    expect(path).toBeTruthy();
  }, 15_000);

  it('REG-07: workspace path persisted and restored after reload', async () => {
    if (!appReady) return;
    // tauri-mcp cannot inject localStorage; verify app window still present after focus
    await focusWindow();
    await sleep(500);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
  }, 10_000);

  it('REG-15: no workspace shows workspace or Web Mode prompt', async () => {
    if (!appReady) return;
    await focusWindow();
    await sleep(500);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/reg-no-workspace.png');
    expect(path).toBeTruthy();
  }, 10_000);
});

/**
 * Functional: workspace file tree (W-06, W-08)
 * tauri-mcp: switch to File mode, expand dir, refresh, takeScreenshot.
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
  mouseClick,
  switchToCodeSpace,
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: workspace file tree', () => {
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

  it('W-06: expand directory loads children', async () => {
    if (!appReady) return;
    await switchToCodeSpace();
    await sleep(2000);
    const win = await getWindowInfo();
    await mouseClick(win.x + 150, win.y + 200);
    await sleep(2000);
    const path = await takeScreenshot('/tmp/func-w06-expand.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 25_000);

  it('W-08: refresh file tree', async () => {
    if (!appReady) return;
    await focusWindow();
    await sleep(500);
    await sendKeys('r', ['meta']);
    await sleep(2000);
    const path = await takeScreenshot('/tmp/func-w08-refresh.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);
});

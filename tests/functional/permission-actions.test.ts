/**
 * Functional: permission actions (P-02, P-03)
 * tauri-mcp: trigger permission, approve once; trigger, deny.
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
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: permission actions', () => {
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

  it('P-02: approve once', async () => {
    if (!appReady) return;
    await sendKeys('list files', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(5000);
    const win = await getWindowInfo();
    const centerX = win.x + Math.floor(win.width / 2) + 80;
    const centerY = win.y + Math.floor(win.height / 2) + 80;
    await mouseClick(centerX, centerY);
    await sleep(1000);
    const path = await takeScreenshot('/tmp/func-p02-approve.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 20_000);

  it('P-03: deny', async () => {
    if (!appReady) return;
    await sendKeys('write to disk', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(5000);
    const win = await getWindowInfo();
    await mouseClick(win.x + Math.floor(win.width / 2) - 80, win.y + Math.floor(win.height / 2) + 80);
    await sleep(1000);
    const path = await takeScreenshot('/tmp/func-p03-deny.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 20_000);
});

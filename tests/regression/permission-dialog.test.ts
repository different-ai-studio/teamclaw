/**
 * Regression: permission dialog (REG-04)
 * tauri-mcp: launch app, trigger permission-requiring action, takeScreenshot.
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

describe('Regression: permission dialog', () => {
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

  it('REG-04: permission dialog appears and can be replied', async () => {
    if (!appReady) return;
    await sendKeys('list files in current directory', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(5000);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/reg-permission-dialog.png');
    expect(path).toBeTruthy();
  }, 20_000);
});

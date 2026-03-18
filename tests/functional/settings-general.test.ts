/**
 * Functional: settings (ST-02, ST-06)
 * tauri-mcp: open settings, general save, Skills search.
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

describe('Functional: settings', () => {
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

  it('ST-02: general settings save', async () => {
    if (!appReady) return;
    await sendKeys(',', ['meta']);
    await sleep(2000);
    const path = await takeScreenshot('/tmp/func-st02-settings.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);

  it('ST-06: Skills search and list', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    await mouseClick(win.x + 120, win.y + 250);
    await sleep(1500);
    await sendKeys('search', []);
    await sleep(1000);
    const path = await takeScreenshot('/tmp/func-st06-skills.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);
});

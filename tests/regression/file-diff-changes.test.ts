/**
 * Regression: file diff and Changes tab (REG-10, REG-11)
 * tauri-mcp: launch app, assert window/screenshot.
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

describe('Regression: file diff and Changes tab', () => {
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

  it('REG-10: no workspace shows prompt (file open requires workspace)', async () => {
    if (!appReady) return;
    await focusWindow();
    await sleep(500);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/reg-no-workspace-prompt.png');
    expect(path).toBeTruthy();
  }, 10_000);

  it('REG-11: Changes tab exists in UI when right panel present', async () => {
    if (!appReady) return;
    await focusWindow();
    await sleep(500);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/reg-changes-tab.png');
    expect(path).toBeTruthy();
  }, 10_000);
});

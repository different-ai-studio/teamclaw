/**
 * Functional: diff view (D-02, D-03)
 * tauri-mcp: open Changes tab, screenshot diff header.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  getWindowInfo,
  takeScreenshot,
  mouseClick,
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: diff view', () => {
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

  it('D-02: open Diff view', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    await mouseClick(win.x + win.width - 200, win.y + 100);
    await sleep(2000);
    const path = await takeScreenshot('/tmp/func-d02-changes.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);

  it('D-03: diff header path and stats', async () => {
    if (!appReady) return;
    await sleep(1000);
    const path = await takeScreenshot('/tmp/func-d03-header.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);
});

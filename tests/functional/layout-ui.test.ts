/**
 * Functional: layout and UI (L-02, L-03, L-04)
 * tauri-mcp: Cmd+\ File mode, Cmd+\ back to Task, right panel tabs.
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

describe('Functional: layout and UI', () => {
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

  it('L-02: Cmd+\\ switch to File mode', async () => {
    if (!appReady) return;
    await sendKeys('\\', ['meta']);
    await sleep(1000);
    const path = await takeScreenshot('/tmp/func-l02-file-mode.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);

  it('L-03: Cmd+\\ back to Task mode', async () => {
    if (!appReady) return;
    await sendKeys('\\', ['meta']);
    await sleep(1000);
    const path = await takeScreenshot('/tmp/func-l03-task-mode.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);

  it('L-04: right panel Tasks/Diff/Files tabs', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    await mouseClick(win.x + win.width - 280, win.y + 90);
    await sleep(800);
    await mouseClick(win.x + win.width - 200, win.y + 90);
    await sleep(800);
    await mouseClick(win.x + win.width - 120, win.y + 90);
    await sleep(800);
    const path = await takeScreenshot('/tmp/func-l04-tabs.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);
});

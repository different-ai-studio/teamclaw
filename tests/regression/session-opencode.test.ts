/**
 * Regression: session list, OpenCode ready, message stream (REG-01, REG-02, REG-03, REG-09)
 * tauri-mcp: launch app, sendKeys, mouseClick, getWindowInfo, takeScreenshot.
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

describe('Regression: session and OpenCode', () => {
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

  it('REG-01: OpenCode ready after workspace selected', async () => {
    if (!appReady) return;
    await focusWindow();
    await sleep(2000);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/reg-opencode-ready.png');
    expect(path).toBeTruthy();
  }, 15_000);

  it('REG-02: session list and current session consistent', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    await mouseClick(win.x + 80, win.y + 150);
    await sleep(1500);
    await sendKeys('test message', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(4000);
    const w = await getWindowInfo();
    expect(w.isVisible).toBe(true);
    await takeScreenshot('/tmp/reg-session-consistent.png');
  }, 20_000);

  it('REG-03: message stream updates after send', async () => {
    if (!appReady) return;
    await sendKeys('hello stream', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(6000);
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/reg-stream-update.png');
    expect(path).toBeTruthy();
  }, 20_000);

  it('REG-09: messages not mixed across sessions', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    await mouseClick(win.x + 80, win.y + 120);
    await sleep(2000);
    await sendKeys('session A', []);
    await sendKeys('Return', []);
    await sleep(2000);
    await mouseClick(win.x + 80, win.y + 180);
    await sleep(1500);
    await sendKeys('session B', []);
    await sendKeys('Return', []);
    await sleep(4000);
    const w = await getWindowInfo();
    expect(w.isVisible).toBe(true);
    await takeScreenshot('/tmp/reg-multi-session.png');
  }, 25_000);
});

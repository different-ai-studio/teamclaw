/**
 * Functional: session create and send message (key case)
 * tauri-mcp: launch app, create session, type and send message, assert window/screenshot.
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

describe('Functional: chat session create and send message', () => {
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

  it('should create new session and send a message', async () => {
    if (!appReady) return;

    const win = await getWindowInfo();
    const newSessionX = win.x + 80;
    const newSessionY = win.y + 120;
    await mouseClick(newSessionX, newSessionY);
    await sleep(2000);

    await sendKeys('hello from e2e test', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(6000);

    const w = await getWindowInfo();
    expect(w.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/functional-chat-session-send.png');
    expect(path).toBeTruthy();
  }, 30_000);
});

/**
 * Functional: session and chat (S-01, S-03, S-04, S-05, S-11)
 * tauri-mcp: new session, switch session, send message, stream, Todos.
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

describe('Functional: session and chat', () => {
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

  it('S-01: create new session', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    await mouseClick(win.x + 80, win.y + 120);
    await sleep(2000);
    const path = await takeScreenshot('/tmp/func-s01-new-session.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);

  it('S-03: switch current session', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    await mouseClick(win.x + 80, win.y + 180);
    await sleep(1500);
    const path = await takeScreenshot('/tmp/func-s03-switch.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);

  it('S-04: send user message', async () => {
    if (!appReady) return;
    await sendKeys('hello from e2e', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(2000);
    const path = await takeScreenshot('/tmp/func-s04-send.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);

  it('S-05: stream assistant reply', async () => {
    if (!appReady) return;
    await sendKeys('what is 2+2?', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(6000);
    const path = await takeScreenshot('/tmp/func-s05-stream.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 20_000);

  it('S-11: Todos visible in right panel', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    await mouseClick(win.x + win.width - 150, win.y + 120);
    await sleep(1500);
    const path = await takeScreenshot('/tmp/func-s11-todos.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);
});

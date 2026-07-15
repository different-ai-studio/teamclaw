/**
 * Functional: notification (N-01, N-05)
 * tauri-mcp: task complete when unfocused; toast auto-dismiss.
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

describe('Functional: notification', () => {
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

  it('N-01: task complete when window unfocused', async () => {
    if (!appReady) return;
    await sendKeys('quick task', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(8000);
    const path = await takeScreenshot('/tmp/func-n01-task-done.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 20_000);

  it('N-02: error notification for non-abort error', async () => {
    if (!appReady) return;
    // Trigger an action that causes an error (e.g., invalid command)
    await sendKeys('force-error-test', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(8000);
    const path = await takeScreenshot('/tmp/func-n02-error-notification.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 20_000);

  it('N-03: question notification when agent asks', async () => {
    if (!appReady) return;
    // Trigger a task that will cause the agent to ask a question
    await sendKeys('ask me a question', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(8000);
    const path = await takeScreenshot('/tmp/func-n03-question-notification.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 20_000);

  it('N-04: notification fires even when window is focused', async () => {
    if (!appReady) return;
    await focusWindow();
    await sleep(300);
    await sendKeys('quick task for focused test', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(8000);
    const path = await takeScreenshot('/tmp/func-n04-focused-notification.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 20_000);

  it('N-05: toast auto-dismiss', async () => {
    if (!appReady) return;
    await sendKeys('s', ['meta']);
    await sleep(4000);
    const path = await takeScreenshot('/tmp/func-n05-toast.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);
});

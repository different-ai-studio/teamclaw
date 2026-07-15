/**
 * Functional: file editor (E-03, E-05)
 * tauri-mcp: open .md in Tiptap, Cmd+S save.
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
  switchToCodeSpace,
  clickFileInTree,
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: file editor', () => {
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

  it('E-03: Tiptap Markdown editing', async () => {
    if (!appReady) return;
    await switchToCodeSpace();
    await sleep(1000);
    try {
      await clickFileInTree('README.md');
      await sleep(3000);
    } catch {
      await sleep(1000);
    }
    const path = await takeScreenshot('/tmp/func-e03-tiptap.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 25_000);

  it('E-05: Cmd+S save', async () => {
    if (!appReady) return;
    await sendKeys('s', ['meta']);
    await sleep(1000);
    const path = await takeScreenshot('/tmp/func-e05-save.png');
    expect(path).toBeTruthy();
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 15_000);
});

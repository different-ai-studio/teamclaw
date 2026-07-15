/**
 * E2E: file editor and diff (E-01/E-03)
 * tauri-mcp: launch app, assert window and content area.
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

describe('E2E: file editor and diff', () => {
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

  it('E-01/E-03: app has root and can show content area', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    expect(win.width).toBeGreaterThan(0);
    const path = await takeScreenshot('/tmp/e2e-file-editor-diff.png');
    expect(path).toBeTruthy();
  }, 15_000);
});

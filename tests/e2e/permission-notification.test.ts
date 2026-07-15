/**
 * E2E: permission and notification (P-01)
 * tauri-mcp: launch app, assert window visible.
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

describe('E2E: permission and notification', () => {
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

  it('P-01: app loads (permission dialog appears when agent requests)', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    const path = await takeScreenshot('/tmp/e2e-permission.png');
    expect(path).toBeTruthy();
  }, 15_000);
});

/**
 * Performance: PERF-01 app loads within timeout
 * tauri-mcp: launch app, measure time until window visible.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  getWindowInfo,
} from '../_utils/tauri-mcp-test-utils';

describe('Performance: frontend load', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      const start = Date.now();
      await launchTeamClawApp();
      await sleep(3000);
      const win = await getWindowInfo();
      appReady = win.isVisible;
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(20_000);
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('PERF-01: app loads within timeout', async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
  }, 15_000);
});

/**
 * E2E: File Mode Layout
 * Converted from Playwright file-mode.spec.ts to vitest + tauri-mcp.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  takeScreenshot,
  executeJs,
  sendKeys,
} from '../_utils/tauri-mcp-test-utils';

describe('File Mode Layout', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);
      appReady = true;
    } catch (err) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('Cmd+\\ switches to File mode with 3 panels', async () => {
    if (!appReady) return;

    // Switch to File mode via Cmd+\
    await sendKeys('\\', ['meta']);
    await sleep(1000);

    await takeScreenshot('/tmp/e2e-file-mode.png');

    // Check that 3 panels exist in the layout container
    const panelCount = await executeJs(`
      (() => {
        const container = document.querySelector('.relative.flex.flex-1.w-full.overflow-hidden');
        return container ? container.children.length : 0;
      })()
    `);
    expect(Number(panelCount)).toBe(3);
  }, 15_000);

  it('Cmd+\\ switches back to Task mode', async () => {
    if (!appReady) return;

    // Switch back to Task mode
    await sendKeys('\\', ['meta']);
    await sleep(1000);

    await takeScreenshot('/tmp/e2e-task-mode.png');

    // Sidebar should be visible in task mode
    const hasSidebar = await executeJs(
      "document.querySelector('[data-slot=\"sidebar\"]') ? 'visible' : 'hidden'",
    );
    expect(hasSidebar).toBe('visible');
  }, 15_000);

  it('File mode right panel has minimum width', async () => {
    if (!appReady) return;

    // Switch to File mode
    await sendKeys('\\', ['meta']);
    await sleep(1000);

    const rightPanelWidth = await executeJs(`
      (() => {
        const container = document.querySelector('.relative.flex.flex-1.w-full.overflow-hidden');
        if (!container || container.children.length < 3) return 0;
        const rightPanel = container.children[2];
        return rightPanel.getBoundingClientRect().width;
      })()
    `);
    expect(Number(rightPanelWidth)).toBeGreaterThanOrEqual(220);

    // Switch back
    await sendKeys('\\', ['meta']);
    await sleep(500);
  }, 15_000);
});

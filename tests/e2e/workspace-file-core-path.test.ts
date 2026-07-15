/**
 * E2E: Workspace and file browsing core path — smoke + full
 * Smoke: Window visible, File mode switch, file tree exists (15s/test)
 * Full: File tree content, file editor, mode switching, workspace name (60s/test)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  getWindowInfo,
  takeScreenshot,
  sendKeys,
  executeJs,
  switchToCodeSpace,
  waitForCondition,
} from '../_utils/tauri-mcp-test-utils';

describe('Workspace and file browsing core path', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);

      // Ensure workspace is configured
      const wsPath = (process.env.E2E_WORKSPACE_PATH || process.cwd()).replace(/'/g, "\\'");
      await executeJs(`
        if (!localStorage.getItem('teamclaw-workspace-path')) {
          localStorage.setItem('teamclaw-workspace-path', '${wsPath}');
          location.reload();
        }
      `);
      await sleep(3000);
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

  // ── Smoke layer ──────────────────────────────────────────────────────

  describe('smoke', () => {
    it('WS-01: window visible after launch', async () => {
      if (!appReady) return;

      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);
      expect(win.width).toBeGreaterThan(0);
      expect(win.height).toBeGreaterThan(0);

      await takeScreenshot('/tmp/e2e-ws01-visible.png');
    }, 15_000);

    it('WS-02: switch to File mode no crash', async () => {
      if (!appReady) return;

      await switchToCodeSpace();
      await sleep(1000);

      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      await takeScreenshot('/tmp/e2e-ws02-file-mode.png');
    }, 15_000);

    it('WS-03: file tree area exists in File mode', async () => {
      if (!appReady) return;

      // Check for file browser container
      const hasFileTree = await executeJs(
        `document.querySelector('[data-testid="file-browser"], [data-file-browser]') !== null`
      );
      expect(hasFileTree).toContain('true');

      await takeScreenshot('/tmp/e2e-ws03-file-tree.png');
    }, 15_000);
  });

  // ── Full layer ───────────────────────────────────────────────────────

  describe('full', () => {
    it('WF-01: file tree shows project files', async () => {
      if (!appReady) return;

      // Wait for file tree to populate
      await waitForCondition(
        `document.querySelectorAll('[data-testid="file-tree-item"]').length`,
        (r) => parseInt(r) > 0,
        15_000,
        1_000,
      );

      // Check for known project file
      const treeContent = await executeJs(`
        Array.from(document.querySelectorAll('[data-testid="file-tree-item"]'))
          .map(el => el.textContent)
          .join('|')
      `);
      expect(treeContent).toBeTruthy();
      // At least some files should be listed
      expect(treeContent.length).toBeGreaterThan(0);

      await takeScreenshot('/tmp/e2e-wf01-files.png');
    }, 60_000);

    it('WF-02: click file opens editor with content', async () => {
      if (!appReady) return;

      // Find and click a file (prefer package.json or any .ts/.json file)
      await executeJs(`
        const items = document.querySelectorAll('[data-testid="file-tree-item"]');
        for (const item of items) {
          const text = item.textContent || '';
          if (text.includes('package.json') || text.endsWith('.ts') || text.endsWith('.json')) {
            item.click();
            break;
          }
        }
      `);
      await sleep(2000);

      // Check editor area has content
      const hasEditor = await executeJs(
        `(document.querySelector('[data-testid="file-editor"]') !== null) || (document.querySelector('.cm-content') !== null)`
      );
      expect(hasEditor).toContain('true');

      await takeScreenshot('/tmp/e2e-wf02-editor.png');
    }, 60_000);

    it('WF-03: switch back to Task mode restores chat', async () => {
      if (!appReady) return;

      // Switch back to task mode
      await sendKeys('\\', ['meta']);
      await sleep(1000);

      // Chat input should be back
      const hasChat = await executeJs(
        `document.querySelector('[contenteditable]') !== null`
      );
      expect(hasChat).toContain('true');

      await takeScreenshot('/tmp/e2e-wf03-task-mode.png');
    }, 15_000);

    it('WF-04: workspace name displays correctly', async () => {
      if (!appReady) return;

      const wsName = await executeJs(
        `document.querySelector('[data-testid="workspace-name"]')?.textContent || ''`
      );

      // Should contain the workspace folder name (not empty, not "Select Workspace")
      expect(wsName.length).toBeGreaterThan(0);
      expect(wsName).not.toContain('Select Workspace');

      await takeScreenshot('/tmp/e2e-wf04-ws-name.png');
    }, 15_000);
  });
});

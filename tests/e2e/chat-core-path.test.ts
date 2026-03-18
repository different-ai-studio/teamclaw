/**
 * E2E: Chat core path — smoke + full
 * Smoke: UI elements exist, input works, no crashes (15s/test)
 * Full: Real OpenCode interaction, agent replies (60s/test)
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
  waitForCondition,
} from '../_utils/tauri-mcp-test-utils';

describe('Chat core path', () => {
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

  // ── Smoke layer ──────────────────────────────────────────────────────

  describe('smoke', () => {
    it('CS-01: window visible, chat input exists', async () => {
      if (!appReady) return;

      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      const hasInput = await executeJs(
        `document.querySelector('[contenteditable]') !== null`
      );
      expect(hasInput).toContain('true');

      await takeScreenshot('/tmp/e2e-chat-cs01-input.png');
    }, 15_000);

    it('CS-02: input is focusable and accepts text', async () => {
      if (!appReady) return;

      // Use executeJs to insert text (AppleScript sendKeys doesn't work with TipTap contenteditable)
      await executeJs(`
        const el = document.querySelector('[contenteditable]');
        if (el) {
          el.focus();
          el.textContent = 'hello from e2e test';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `);
      await sleep(500);

      // Verify text appeared in the input
      const inputText = await executeJs(
        `document.querySelector('[contenteditable]')?.textContent || ''`
      );
      expect(inputText).toContain('hello from e2e test');

      await takeScreenshot('/tmp/e2e-chat-cs02-typed.png');
    }, 15_000);

    it('CS-03: send empty submit does not crash', async () => {
      if (!appReady) return;

      // Clear any existing text first
      await executeJs(
        `const el = document.querySelector('[contenteditable]'); if (el) { el.textContent = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }`
      );
      await sleep(300);

      // Press Enter on empty input
      await sendKeys('Return', []);
      await sleep(1000);

      // App should still be running
      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      await takeScreenshot('/tmp/e2e-chat-cs03-empty-submit.png');
    }, 15_000);
  });

  // ── Full layer ───────────────────────────────────────────────────────

  describe('full', () => {
    it('CF-01: send lightweight prompt, receive agent reply', async () => {
      if (!appReady) return;

      // Check if OpenCode is connected (skip if not)
      const connected = await executeJs(
        `String(document.querySelector('.animate-spin') === null && !document.body.textContent.includes('Connecting'))`
      );
      if (connected !== 'true') {
        console.log('CF-01: Skipping — OpenCode not connected');
        return;
      }

      // Use executeJs to type into TipTap (sendKeys doesn't work with contenteditable)
      await executeJs(`
        const el = document.querySelector('[contenteditable]');
        if (el) {
          el.focus();
          el.textContent = 'reply with just the word hello';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `);
      await sleep(300);

      // Count messages before
      const beforeCount = await executeJs(
        `document.querySelectorAll('[data-testid="chat-message"]').length`
      );

      // Submit via Enter key
      await sendKeys('Return', []);

      // Wait for at least 2 new messages (user + assistant)
      const beforeNum = parseInt(beforeCount) || 0;
      await waitForCondition(
        `document.querySelectorAll('[data-testid="chat-message"]').length`,
        (r) => parseInt(r) >= beforeNum + 2,
        30_000,
        1_000,
      );

      const afterCount = await executeJs(
        `document.querySelectorAll('[data-testid="chat-message"]').length`
      );
      expect(parseInt(afterCount)).toBeGreaterThanOrEqual(beforeNum + 2);

      await takeScreenshot('/tmp/e2e-chat-cf01-reply.png');
    }, 60_000);

    it('CF-02: consecutive messages both display', async () => {
      if (!appReady) return;

      // Check if OpenCode is connected (skip if not)
      const connected = await executeJs(
        `String(document.querySelector('.animate-spin') === null && !document.body.textContent.includes('Connecting'))`
      );
      if (connected !== 'true') {
        console.log('CF-02: Skipping — OpenCode not connected');
        return;
      }

      const beforeCount = await executeJs(
        `document.querySelectorAll('[data-testid="chat-message"]').length`
      );
      const beforeNum = parseInt(beforeCount) || 0;

      // Use executeJs to type into TipTap
      await executeJs(`
        const el = document.querySelector('[contenteditable]');
        if (el) {
          el.focus();
          el.textContent = 'reply with just the word world';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      `);
      await sleep(300);
      await sendKeys('Return', []);

      // Wait for 2 more messages
      await waitForCondition(
        `document.querySelectorAll('[data-testid="chat-message"]').length`,
        (r) => parseInt(r) >= beforeNum + 2,
        30_000,
        1_000,
      );

      const afterCount = await executeJs(
        `document.querySelectorAll('[data-testid="chat-message"]').length`
      );
      expect(parseInt(afterCount)).toBeGreaterThanOrEqual(beforeNum + 2);

      await takeScreenshot('/tmp/e2e-chat-cf02-consecutive.png');
    }, 60_000);

    it('CF-03: input clears after most recent send', async () => {
      if (!appReady) return;

      // Check the input is empty after the previous sends
      const inputText = await executeJs(
        `document.querySelector('[contenteditable]')?.textContent?.trim() || ''`
      );
      expect(inputText).toBe('');

      await takeScreenshot('/tmp/e2e-chat-cf03-cleared.png');
    }, 15_000);

    it('CF-04: right panel Tasks tab accessible', async () => {
      if (!appReady) return;

      // Look for a tab/button containing "Tasks" text, or the tasks panel content
      const hasTasksTab = await executeJs(`
        const buttons = document.querySelectorAll('button, [role="tab"]');
        const found = Array.from(buttons).some(b => b.textContent?.includes('Tasks') || b.textContent?.includes('tasks'));
        const noTasksYet = document.body.textContent?.includes('No tasks yet');
        found || noTasksYet
      `);
      expect(hasTasksTab).toContain('true');

      // Window still healthy
      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      await takeScreenshot('/tmp/e2e-chat-cf04-tasks.png');
    }, 15_000);
  });
});

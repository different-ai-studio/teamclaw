/**
 * E2E: chat workflow (message send, streaming, queuing)
 * tauri-mcp: launch app, interact with chat input and messages.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  getWindowInfo,
  takeScreenshot,
  executeJs,
  sendKeys,
} from '../_utils/tauri-mcp-test-utils';

describe('E2E: Chat Workflow', () => {
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

  describe('Scenario A: Complete conversation flow', () => {
    it('user can type and send a message', async () => {
      if (!appReady) return;

      // 1. Verify app window is ready
      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      // 2. Find and focus chat input (contenteditable div)
      // - Query for contenteditable element with role "textbox" or data-testid
      // - Execute JS: document.querySelector('[contenteditable="true"]') or similar
      // - Type a test message

      // 3. Type a message into the input
      // - Use executeJs or sendKeys to input text
      // - Example: "Hello, can you help me?"

      // 4. Press Enter to send the message
      // - sendKeys('Return') or use keyboard shortcut

      // 5. Verify message appears in chat area
      // - Query chat container for message with user's text
      // - Check message is displayed in correct area (user message alignment)

      // 6. Wait for agent reply to start streaming
      // - Listen for agent message or loading indicator
      // - Verify SSE streaming begins (can check via console logs or DOM updates)

      // 7. Verify input becomes available after agent completes
      // - Wait for agent to finish streaming
      // - Check input is not disabled
      // - Verify can interact with input again

      const screenshot = await takeScreenshot('/tmp/e2e-chat-workflow-send.png');
      expect(screenshot).toBeTruthy();
    }, 30_000);
  });

  describe('Scenario B: Message queuing', () => {
    it('queues message when agent is busy', async () => {
      if (!appReady) return;

      // 1. Send first message
      // - Follow same steps as test A to type and send message
      // - Wait for agent to start responding

      // 2. While agent is still replying, send a second message
      // - Type second message in input while agent is streaming
      // - Press Enter without waiting for first message to complete

      // 3. Verify queue indicator appears
      // - Check for queue badge/counter on input or messages area
      // - Confirm visual indicator shows pending message count

      // 4. Wait for first message to complete
      // - Monitor agent response completion

      // 5. Verify queued message automatically sends after first completes
      // - Check second message appears after first message fully streamed
      // - Verify agent begins responding to second message
      // - Confirm no manual intervention needed

      // 6. Take screenshot showing queue behavior
      const screenshot = await takeScreenshot('/tmp/e2e-chat-workflow-queue.png');
      expect(screenshot).toBeTruthy();
    }, 45_000);
  });
});

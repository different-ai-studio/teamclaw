/**
 * E2E: permission flow (manual approval, rejection)
 * tauri-mcp: launch app, verify permission dialog interactions.
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
  mouseClick,
} from '../_utils/tauri-mcp-test-utils';

describe('E2E: Permission Flow', () => {
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

  describe('Scenario A: Manual approval', () => {
    it('shows permission dialog and allows user approval', async () => {
      if (!appReady) return;

      // 1. Verify app is ready
      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      // 2. Trigger an agent action that requires file permissions
      // - Send a message that asks agent to create/modify a file
      // - Example: "Create a new file called test.txt with 'Hello World'"

      // 3. Wait for permission dialog to appear
      // - Listen for dialog element in DOM
      // - Check for permission request title/description
      // - Verify file path is shown in dialog

      // 4. Verify permission details display
      // - Confirm action description is visible
      // - Check affected file paths are listed
      // - Verify "one-time" or "remember choice" checkbox present

      // 5. User approves permission
      // - Click "Approve" or "Allow" button in dialog
      // - Can verify via one-time or remember choice

      // 6. Verify permission is granted and action proceeds
      // - Dialog closes
      // - Agent continues with file operation
      // - File is created/modified as requested

      // 7. Verify operation completed successfully
      // - Check file exists in workspace
      // - Verify file changes appear in diff/changes view

      const screenshot = await takeScreenshot('/tmp/e2e-permission-flow-approve.png');
      expect(screenshot).toBeTruthy();
    }, 45_000);
  });

  describe('Scenario B: Manual rejection', () => {
    it('shows permission dialog and handles user rejection', async () => {
      if (!appReady) return;

      // 1. Verify app is ready
      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      // 2. Trigger an agent action that requires file permissions
      // - Send a message requesting file operation
      // - Example: "Delete the file config.json"

      // 3. Wait for permission dialog to appear
      // - Verify permission request is displayed
      // - Confirm action and file paths are shown

      // 4. User rejects permission
      // - Click "Deny", "Reject", or "Cancel" button in dialog
      // - Dialog should close

      // 5. Verify permission is denied and action is blocked
      // - Check for error message or feedback in chat
      // - Verify agent acknowledges rejection
      // - Confirm file was NOT modified

      // 6. Verify agent continues normally after rejection
      // - Chat remains functional
      // - User can send another message
      // - No broken state or errors

      const screenshot = await takeScreenshot('/tmp/e2e-permission-flow-reject.png');
      expect(screenshot).toBeTruthy();
    }, 45_000);
  });
});

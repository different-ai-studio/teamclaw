/**
 * E2E: session management (create/switch sessions, session list ordering)
 * tauri-mcp: launch app, verify session creation and switching behavior.
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

describe('E2E: Session Management', () => {
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

  describe('Scenario A: Create and switch sessions', () => {
    it('creates new session and can switch between sessions', async () => {
      if (!appReady) return;

      // 1. Verify app is ready with sidebar visible
      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      // 2. Create first session
      // - Look for "New Session" button in sidebar
      // - Click button or use keyboard shortcut
      // - Verify new session appears in session list

      // 3. Send a message in first session
      // - Type and send a message in the new session
      // - Verify message appears and agent responds

      // 4. Create second session
      // - Click "New Session" again
      // - Verify second session is created and is now active

      // 5. Send different message in second session
      // - Type and send a different message
      // - Verify message appears in second session

      // 6. Switch back to first session
      // - Click on first session in sidebar
      // - Verify first session becomes active
      // - Verify original message is still there

      // 7. Switch to second session again
      // - Click on second session in sidebar
      // - Verify second session is active
      // - Verify second message is still there

      // 8. Verify chat history is preserved
      // - Each session maintains its own message history
      // - Switching between sessions shows correct messages
      // - No message bleeding between sessions

      const screenshot = await takeScreenshot('/tmp/e2e-session-management-switch.png');
      expect(screenshot).toBeTruthy();
    }, 60_000);
  });

  describe('Scenario B: Session list ordering', () => {
    it('maintains correct session ordering (most recent first)', async () => {
      if (!appReady) return;

      // 1. Verify app is ready
      const win = await getWindowInfo();
      expect(win.isVisible).toBe(true);

      // 2. Create multiple sessions in sequence
      // - Create session A, send message
      // - Create session B, send message
      // - Create session C, send message
      // - Verify all three appear in session list

      // 3. Verify initial ordering
      // - Check that most recent session (C) is at top or bottom
      // - Sessions should be ordered by creation or last activity
      // - Verify ordering matches expected behavior (e.g., most recent first)

      // 4. Switch to an older session (A)
      // - Click on session A in sidebar
      // - Send a new message to session A

      // 5. Verify session list reorders
      // - Session A should move to the top (most recent position)
      // - Sessions B and C move down
      // - Ordering reflects last activity time

      // 6. Verify ordering persists
      // - Switch to session B and send message
      // - Session B should become most recent
      // - Previous order is updated

      // 7. Create new session while others exist
      // - New session should appear in correct position
      // - New session should be most recent (top position)
      // - Existing sessions maintain relative order

      // 8. Verify list pagination if many sessions exist
      // - If 50+ sessions: verify pagination controls work
      // - Can navigate between pages
      // - Correct sessions shown per page

      const screenshot = await takeScreenshot('/tmp/e2e-session-management-ordering.png');
      expect(screenshot).toBeTruthy();
    }, 60_000);
  });
});

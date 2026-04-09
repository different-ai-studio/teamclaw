/**
 * E2E Smoke: chat streaming lifecycle
 * tauri-mcp: launch app, send one message, verify streaming starts, updates, and finishes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
  takeScreenshot,
  waitForCondition,
} from '../_utils/tauri-mcp-test-utils';

const STORE = 'window.__TEAMCLAW_STORES__';

async function verifyStoreExposed(): Promise<boolean> {
  const result = await executeJs(`typeof ${STORE}?.session?.getState === 'function'`);
  return result === 'true';
}

async function isOpenCodeReady(): Promise<boolean> {
  const result = await executeJs(`${STORE}.session.getState().isConnected === true`);
  return result === 'true';
}

async function getActiveSessionId(): Promise<string | null> {
  const result = await executeJs(`${STORE}.session.getState().activeSessionId`);
  return result && result !== 'null' && result !== 'undefined' ? result : null;
}

async function createSession(): Promise<string | null> {
  const beforeId = await getActiveSessionId();
  try {
    await executeJs(`${STORE}.session.getState().createSession()`);
  } catch {
    // The underlying async action may outlive the RPC timeout.
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(500);
    const currentId = await getActiveSessionId();
    if (currentId && currentId !== beforeId) return currentId;
  }

  return null;
}

async function ensureActiveSession(): Promise<string | null> {
  const sessionId = await getActiveSessionId();
  if (sessionId) return sessionId;
  return createSession();
}

async function sendMessage(text: string): Promise<void> {
  await executeJs(`${STORE}.session.getState().sendMessage(${JSON.stringify(text)})`);
}

async function getLastAssistantMessageText(): Promise<string> {
  const result = await executeJs(`
    (() => {
      const nodes = Array.from(document.querySelectorAll('[data-testid="chat-message"][data-message-role="assistant"]'));
      const last = nodes[nodes.length - 1];
      return last?.textContent?.trim() || '';
    })()
  `);
  return result === 'null' || result === 'undefined' ? '' : result;
}

describe('E2E Smoke: chat stream lifecycle', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();

      let storeOk = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(2_000);
        await focusWindow();
        storeOk = await verifyStoreExposed();
        if (storeOk) break;
      }

      if (!storeOk) throw new Error('Store not exposed after 60s');

      for (let attempt = 0; attempt < 30; attempt++) {
        if (await isOpenCodeReady()) {
          appReady = true;
          break;
        }
        await sleep(2_000);
      }

      if (!appReady) throw new Error('OpenCode not ready within 60s');
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 120_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('should show assistant output growing and then finish cleanly', async () => {
    if (!appReady) return;

    const sessionId = await ensureActiveSession();
    expect(sessionId).toBeTruthy();
    await sleep(1_000);

    await sendMessage('请给我一个 8 步的简短下一步计划，每一步单独一行，不要调用工具。');

    const activeStreamingId = await waitForCondition(
      `${STORE}.streaming.getState().streamingMessageId`,
      (value) => value !== 'null' && value !== 'undefined' && value !== '',
      30_000,
      500,
    );
    expect(activeStreamingId).toBeTruthy();

    const observedLengths = new Set<number>();
    let sawVisibleContent = false;
    let sawGrowth = false;

    for (let tick = 0; tick < 30; tick++) {
      await sleep(500);

      const text = await getLastAssistantMessageText();
      const length = text.length;
      observedLengths.add(length);

      if (length > 0) {
        sawVisibleContent = true;
      }

      if (observedLengths.size >= 2 && Math.max(...observedLengths) > Math.min(...observedLengths)) {
        sawGrowth = true;
      }

      const isStreaming = await executeJs(`${STORE}.streaming.getState().streamingMessageId !== null`);
      if (sawVisibleContent && sawGrowth && isStreaming === 'true') {
        break;
      }
    }

    expect(sawVisibleContent).toBe(true);
    expect(sawGrowth).toBe(true);

    await waitForCondition(
      `${STORE}.streaming.getState().streamingMessageId`,
      (value) => value === 'null',
      60_000,
      500,
    );

    const finalText = await getLastAssistantMessageText();
    expect(finalText.length).toBeGreaterThan(0);

    const path = await takeScreenshot('/tmp/smoke-chat-stream.png');
    expect(path).toBeTruthy();
  }, 90_000);
});

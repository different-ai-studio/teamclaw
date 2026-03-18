import { executeJs, waitForCondition, takeScreenshot, sleep } from '../_utils/tauri-mcp-test-utils';

const STORE = 'window.__TEAMCLAW_STORES__';

export async function verifyStoreExposed(): Promise<boolean> {
  const result = await executeJs(`typeof ${STORE}?.session?.getState === 'function'`);
  return result === 'true';
}

export async function isOpenCodeReady(): Promise<boolean> {
  const result = await executeJs(
    `${STORE}.session.getState().isConnected === true`
  );
  return result === 'true';
}

export async function waitForIdle(timeoutMs = 30_000): Promise<void> {
  await waitForCondition(
    `(() => {
      const s = ${STORE}.session.getState().sessionStatus;
      return String(!s || s.type === 'idle' || s === undefined);
    })()`,
    (r) => r === 'true',
    timeoutMs,
    1_000,
  );
}

export async function createSession(): Promise<string | null> {
  const beforeId = await getActiveSessionId();
  await executeJs(`${STORE}.session.getState().createSession()`);
  let newId: string | null = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const currentId = await getActiveSessionId();
    if (currentId && currentId !== beforeId) {
      newId = currentId;
      break;
    }
  }
  return newId;
}

export async function switchSession(sessionId: string): Promise<void> {
  await executeJs(`${STORE}.session.getState().setActiveSession(${JSON.stringify(sessionId)})`);
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const current = await getActiveSessionId();
    if (current === sessionId) return;
  }
  console.warn(`[stress] switchSession: activeSessionId did not change to ${sessionId} within 3s`);
}

export async function sendMessage(text: string): Promise<void> {
  await executeJs(`${STORE}.session.getState().sendMessage(${JSON.stringify(text)})`);
}

export async function getMessageCount(sessionId: string): Promise<number> {
  const result = await executeJs(
    `${STORE}.session.getState().getSessionMessages(${JSON.stringify(sessionId)}).length`
  );
  return parseInt(result) || 0;
}

export async function waitForMessageCount(
  sessionId: string,
  expectedCount: number,
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    `${STORE}.session.getState().getSessionMessages(${JSON.stringify(sessionId)}).length`,
    (r) => parseInt(r) >= expectedCount,
    timeoutMs,
    1_000,
  );
}

export async function checkSessionError(): Promise<string | null> {
  const result = await executeJs(
    `JSON.stringify(${STORE}.session.getState().sessionError)`
  );
  return result && result !== 'null' && result !== 'undefined' ? result : null;
}

export async function pollForError(windowMs = 10_000): Promise<string | null> {
  try {
    await waitForCondition(
      `JSON.stringify(${STORE}.session.getState().sessionError)`,
      (r) => r !== 'null' && r !== 'undefined' && r !== '',
      windowMs,
      1_000,
    );
    return await checkSessionError();
  } catch {
    return null;
  }
}

export async function archiveSession(sessionId: string): Promise<void> {
  await executeJs(`${STORE}.session.getState().archiveSession(${JSON.stringify(sessionId)})`);
  await sleep(1000);
}

export async function getActiveSessionId(): Promise<string | null> {
  const result = await executeJs(
    `${STORE}.session.getState().activeSessionId`
  );
  return result && result !== 'null' && result !== 'undefined' ? result : null;
}

export async function captureErrorScreenshot(
  reportDir: string,
  index: number,
): Promise<string> {
  const timestamp = Date.now();
  const path = `${reportDir}/screenshots/error-${timestamp}-${index}.png`;
  return takeScreenshot(path);
}

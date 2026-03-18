import { callIpcCommand, takeScreenshot, sleep } from '../_utils/tauri-mcp-test-utils';

const STORE = 'window.__TEAMCLAW_STORES__';

/**
 * Execute JS in the main webview via the webview_eval_js IPC command.
 * This bypasses the broken tauri-plugin-mcp execute_js event system.
 */
async function evalJs(code: string): Promise<string> {
  const result = await callIpcCommand('webview_eval_js', { code });
  return result;
}

/**
 * Poll an evalJs expression until the predicate passes or timeout.
 */
async function waitForCondition(
  jsCode: string,
  predicate: (result: string) => boolean,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await evalJs(jsCode);
      if (predicate(result)) return result;
    } catch {
      // evalJs may fail transiently, keep polling
    }
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms: ${jsCode}`);
}

export async function verifyStoreExposed(): Promise<boolean> {
  const result = await evalJs(`typeof ${STORE}?.session?.getState === 'function'`);
  return result === 'true';
}

export async function isOpenCodeReady(): Promise<boolean> {
  const result = await evalJs(
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
  await evalJs(`${STORE}.session.getState().createSession()`);
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
  await evalJs(`${STORE}.session.getState().setActiveSession(${JSON.stringify(sessionId)})`);
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const current = await getActiveSessionId();
    if (current === sessionId) return;
  }
  throw new Error(`switchSession: activeSessionId did not change to ${sessionId} within 3s`);
}

export async function sendMessage(text: string): Promise<void> {
  await evalJs(`${STORE}.session.getState().sendMessage(${JSON.stringify(text)})`);
}

export async function getMessageCount(sessionId: string): Promise<number> {
  const result = await evalJs(
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
  const result = await evalJs(
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
  await evalJs(`${STORE}.session.getState().archiveSession(${JSON.stringify(sessionId)})`);
  await sleep(1000);
}

export async function getActiveSessionId(): Promise<string | null> {
  const result = await evalJs(
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

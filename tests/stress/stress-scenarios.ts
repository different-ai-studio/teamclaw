import {
  createSession,
  switchSession,
  sendMessage,
  getMessageCount,
  waitForMessageCount,
  pollForError,
  archiveSession,
  captureErrorScreenshot,
} from './stress-helpers';
import type { StressConfig } from './stress-config';
import type { InteractionRecord, StressReporter } from './stress-reporter';

const TEST_PROMPT = 'reply with just the word hello';

async function runOneInteraction(
  sessionId: string,
  messageIndex: number,
  scenario: InteractionRecord['scenario'],
  config: StressConfig,
  reporter: StressReporter,
): Promise<boolean> {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const beforeCount = await getMessageCount(sessionId);
    await sendMessage(TEST_PROMPT);
    const expectedCount = beforeCount + 2;

    let error: string | null = null;
    let success = false;

    try {
      await waitForMessageCount(sessionId, expectedCount, config.messageTimeoutMs);
      success = true;
    } catch (waitErr: any) {
      error = await pollForError(5_000);
      if (!error) {
        error = JSON.stringify({ type: 'timeout', message: waitErr.message });
      }
    }

    const responseTimeMs = Date.now() - startMs;

    if (success) {
      reporter.record({
        timestamp, scenario, sessionId, messageIndex, responseTimeMs, success: true,
      });
    } else {
      let errorType: InteractionRecord['error'] = { type: 'unknown', message: 'Unknown error' };
      try {
        const parsed = JSON.parse(error!);
        if (parsed.type) {
          errorType = { type: parsed.type, message: parsed.message || parsed.data?.message || 'Unknown' };
        } else if (parsed.name) {
          errorType = { type: 'send_error', message: parsed.data?.message || parsed.name };
        } else {
          errorType = { type: 'timeout', message: String(error) };
        }
      } catch {
        errorType = { type: 'timeout', message: String(error).slice(0, 200) };
      }

      try {
        const screenshotPath = await captureErrorScreenshot(config.reportDir, messageIndex);
        errorType.screenshot = screenshotPath;
      } catch { /* screenshot is best-effort */ }

      reporter.record({
        timestamp, scenario, sessionId, messageIndex, responseTimeMs, success: false, error: errorType,
      });
    }

    return success;
  } catch (outerErr: any) {
    const responseTimeMs = Date.now() - startMs;
    reporter.record({
      timestamp, scenario, sessionId, messageIndex, responseTimeMs, success: false,
      error: { type: 'socket_error', message: outerErr.message?.slice(0, 200) || 'Unknown outer error' },
    });
    return false;
  }
}

export async function runSingleSession(
  deadlineMs: number,
  config: StressConfig,
  reporter: StressReporter,
): Promise<void> {
  console.log(`[stress] Starting single session scenario (${Math.round(deadlineMs / 60000)} min)`);
  const deadline = Date.now() + deadlineMs;

  const sessionId = await createSession();
  if (!sessionId) throw new Error('Failed to create session for single-session scenario');
  reporter.trackSessionCreated(sessionId);

  let msgIndex = 0;
  while (Date.now() < deadline) {
    await switchSession(sessionId);
    await runOneInteraction(sessionId, msgIndex++, 'single', config, reporter);
  }

  await archiveSession(sessionId);
  console.log(`[stress] Single session scenario done. ${msgIndex} messages sent.`);
}

export async function runMultiSession(
  deadlineMs: number,
  config: StressConfig,
  reporter: StressReporter,
): Promise<void> {
  console.log(`[stress] Starting multi session scenario (${Math.round(deadlineMs / 60000)} min, ${config.concurrentSessions} sessions)`);
  const deadline = Date.now() + deadlineMs;

  const sessionIds: string[] = [];
  for (let i = 0; i < config.concurrentSessions; i++) {
    const id = await createSession();
    if (!id) throw new Error(`Failed to create session ${i + 1}`);
    sessionIds.push(id);
    reporter.trackSessionCreated(id);
  }

  let msgIndex = 0;
  while (Date.now() < deadline) {
    for (const sessionId of sessionIds) {
      if (Date.now() >= deadline) break;
      await switchSession(sessionId);
      await runOneInteraction(sessionId, msgIndex++, 'multi', config, reporter);
    }
  }

  for (const id of sessionIds) {
    await archiveSession(id);
  }
  console.log(`[stress] Multi session scenario done. ${msgIndex} messages sent.`);
}

export async function runMixedMode(
  deadlineMs: number,
  config: StressConfig,
  reporter: StressReporter,
): Promise<void> {
  console.log(`[stress] Starting mixed mode scenario (${Math.round(deadlineMs / 60000)} min)`);
  const deadline = Date.now() + deadlineMs;

  const persistentId = await createSession();
  if (!persistentId) throw new Error('Failed to create persistent session');
  reporter.trackSessionCreated(persistentId);

  const shortLivedIds: string[] = [];
  let lastNewSessionTime = Date.now();
  let msgIndex = 0;

  while (Date.now() < deadline) {
    if (Date.now() - lastNewSessionTime >= config.mixedNewSessionIntervalMs) {
      const shortId = await createSession();
      if (shortId) {
        reporter.trackSessionCreated(shortId);
        const msgCount = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < msgCount && Date.now() < deadline; i++) {
          await switchSession(shortId);
          await runOneInteraction(shortId, msgIndex++, 'mixed', config, reporter);
        }
        await archiveSession(shortId);
        shortLivedIds.push(shortId);
      }
      lastNewSessionTime = Date.now();
    }

    if (Date.now() < deadline) {
      await switchSession(persistentId);
      await runOneInteraction(persistentId, msgIndex++, 'mixed', config, reporter);
    }
  }

  await archiveSession(persistentId);
  console.log(`[stress] Mixed mode scenario done. ${msgIndex} messages sent, ${shortLivedIds.length + 1} sessions used.`);
}

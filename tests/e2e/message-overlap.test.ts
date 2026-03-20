/**
 * E2E: Message overlap regression test
 *
 * Reproduces a bug where the assistant's streaming text visually overlaps
 * the user message bubble above it. Checks bounding-box separation of
 * consecutive user → assistant message elements during and after streaming.
 *
 * Requires: running TeamClaw dev app (pnpm tauri dev) with __TEAMCLAW_STORES__
 * exposed on window.
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
  } catch { /* async — may timeout */ }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const currentId = await getActiveSessionId();
    if (currentId && currentId !== beforeId) return currentId;
  }
  return null;
}

async function sendMessage(text: string): Promise<void> {
  await executeJs(`${STORE}.session.getState().sendMessage(${JSON.stringify(text)})`);
}

/**
 * Get bounding rects for all chat messages currently in the DOM.
 * Returns array of { role, top, bottom, height } ordered by DOM position.
 */
async function getMessageBoundingRects(): Promise<
  Array<{ role: string; top: number; bottom: number; height: number }>
> {
  const json = await executeJs(`
    (() => {
      const msgs = document.querySelectorAll('[data-testid="chat-message"]');
      return JSON.stringify(Array.from(msgs).map(el => {
        const rect = el.getBoundingClientRect();
        return {
          role: el.getAttribute('data-message-role') || 'unknown',
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
        };
      }));
    })()
  `);
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/**
 * Check if any consecutive user→assistant messages have overlapping bounding boxes.
 * Returns overlap info if found, null otherwise.
 */
function findOverlap(
  rects: Array<{ role: string; top: number; bottom: number; height: number }>,
): { userIdx: number; assistantIdx: number; overlapPx: number } | null {
  for (let i = 0; i < rects.length - 1; i++) {
    const curr = rects[i];
    const next = rects[i + 1];
    if (curr.role === 'user' && next.role === 'assistant') {
      const overlap = curr.bottom - next.top;
      // Allow 1px tolerance for subpixel rounding
      if (overlap > 1) {
        return { userIdx: i, assistantIdx: i + 1, overlapPx: overlap };
      }
    }
  }
  return null;
}

describe('Message overlap during streaming', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      console.log('[overlap] App launched, waiting for webview...');

      let storeOk = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(2_000);
        try {
          await focusWindow();
          storeOk = await verifyStoreExposed();
          if (storeOk) break;
        } catch (err: any) {
          console.log(`[overlap] Waiting... attempt ${attempt + 1}/30`);
        }
      }
      if (!storeOk) throw new Error('Store not exposed after 60s');

      for (let i = 0; i < 30; i++) {
        if (await isOpenCodeReady()) { appReady = true; break; }
        await sleep(2_000);
      }
      if (!appReady) throw new Error('OpenCode not ready within 60s');
      console.log('[overlap] App ready.');
    } catch (err) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 120_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('short user message → streaming assistant: no overlap', async () => {
    if (!appReady) return;

    const sessionId = await createSession();
    expect(sessionId).toBeTruthy();
    await sleep(1000);

    // Send a short message
    await sendMessage('请简单介绍一下自己');

    // Check during streaming: poll for assistant message to appear then check overlap
    let overlapFound = false;
    let screenshotPath = '';
    for (let tick = 0; tick < 30; tick++) {
      await sleep(500);
      const rects = await getMessageBoundingRects();
      if (rects.length >= 2) {
        const overlap = findOverlap(rects);
        if (overlap) {
          overlapFound = true;
          screenshotPath = await takeScreenshot('/tmp/overlap-short-msg.png');
          console.log('[overlap] OVERLAP DETECTED (short msg):', overlap, 'screenshot:', screenshotPath);
          break;
        }
      }
      // Stop if streaming is done
      const isStreaming = await executeJs(`${STORE}.streaming.getState().streamingMessageId !== null`);
      if (isStreaming === 'false' && rects.length >= 2) break;
    }

    expect(overlapFound).toBe(false);
  }, 60_000);

  it('long user message (collapsed) → streaming assistant: no overlap', async () => {
    if (!appReady) return;

    const sessionId = await createSession();
    expect(sessionId).toBeTruthy();
    await sleep(1000);

    // Send a very long message to trigger the collapse mechanism (>200px height)
    const longContent = `帮助把上面的内容写成一个skills，名字为googledoc-2-nutstore，后续会给一个详细的需求文档。

这个技能需要：
1. 自动读取指定的 Google Docs 文档内容
2. 使用 LLM 对文档内容进行智能总结
3. 将总结后的内容格式化为 Markdown
4. 自动上传到坚果云指定目录
5. 支持定时执行和手动触发两种模式
6. 需要处理 Google OAuth2 认证流程
7. 支持多个文档的批量处理
8. 提供执行日志和错误报告
9. 总结模板可以自定义配置
10. 支持增量更新，只处理上次同步后修改过的文档

请帮我写一个完整的 skill 文件，包括所有必要的配置和说明。这是一个比较复杂的跨平台集成任务，需要考虑到各种边界情况和错误处理。

另外还需要：
- 支持 Google Sheets 和 Google Slides 的内容提取
- 坚果云 WebDAV 协议的文件上传
- 断点续传和重试机制
- 文件冲突检测和解决策略`;

    await sendMessage(longContent);

    // Check during streaming
    let overlapFound = false;
    let screenshotPath = '';
    for (let tick = 0; tick < 30; tick++) {
      await sleep(500);
      const rects = await getMessageBoundingRects();
      if (rects.length >= 2) {
        const overlap = findOverlap(rects);
        if (overlap) {
          overlapFound = true;
          screenshotPath = await takeScreenshot('/tmp/overlap-long-msg.png');
          console.log('[overlap] OVERLAP DETECTED (long msg):', overlap, 'screenshot:', screenshotPath);
          break;
        }
      }
      const isStreaming = await executeJs(`${STORE}.streaming.getState().streamingMessageId !== null`);
      if (isStreaming === 'false' && rects.length >= 2) break;
    }

    // Also check after streaming completes
    await sleep(2000);
    const finalRects = await getMessageBoundingRects();
    const finalOverlap = findOverlap(finalRects);
    if (finalOverlap && !overlapFound) {
      overlapFound = true;
      screenshotPath = await takeScreenshot('/tmp/overlap-long-msg-final.png');
      console.log('[overlap] OVERLAP DETECTED post-stream (long msg):', finalOverlap, 'screenshot:', screenshotPath);
    }

    expect(overlapFound).toBe(false);
  }, 90_000);

  it('message with inline code → streaming assistant with tool call: no overlap', async () => {
    if (!appReady) return;

    const sessionId = await createSession();
    expect(sessionId).toBeTruthy();
    await sleep(1000);

    // This mirrors the exact scenario from the bug screenshot
    await sendMessage('帮助把上面的内容写成一个skills，名字为googledoc-2-nutstore，后续会给一个详细的说明文档，用于自动读取 Google Docs 总结一下上传到坚果云。');

    let overlapFound = false;
    let maxOverlap = 0;
    let screenshotTaken = false;

    for (let tick = 0; tick < 40; tick++) {
      await sleep(500);
      const rects = await getMessageBoundingRects();

      if (rects.length >= 2) {
        const overlap = findOverlap(rects);
        if (overlap && overlap.overlapPx > maxOverlap) {
          maxOverlap = overlap.overlapPx;
          if (!screenshotTaken) {
            const path = await takeScreenshot('/tmp/overlap-tool-call.png');
            console.log('[overlap] OVERLAP DETECTED (tool call scenario):', overlap, 'screenshot:', path);
            screenshotTaken = true;
          }
          overlapFound = true;
        }
      }

      // Also check during tool execution (the writing file stage)
      const hasToolCalls = await executeJs(`
        (() => {
          const cards = document.querySelectorAll('[data-testid="chat-message"][data-message-role="assistant"]');
          for (const card of cards) {
            if (card.textContent?.includes('Writing file') || card.textContent?.includes('写入文件')) return 'true';
          }
          return 'false';
        })()
      `);

      const isStreaming = await executeJs(`${STORE}.streaming.getState().streamingMessageId !== null`);
      if (isStreaming === 'false' && rects.length >= 2) break;
    }

    if (overlapFound) {
      console.log(`[overlap] Max overlap: ${maxOverlap}px`);
    }

    expect(overlapFound).toBe(false);
  }, 90_000);

  it('rapid successive messages: no cumulative overlap', async () => {
    if (!appReady) return;

    const sessionId = await createSession();
    expect(sessionId).toBeTruthy();
    await sleep(1000);

    // Send first message and wait for completion
    await sendMessage('说一个字：好');
    await waitForCondition(
      `${STORE}.streaming.getState().streamingMessageId`,
      (r) => r === 'null',
      30_000,
      500,
    );
    await sleep(500);

    // Send second message immediately
    await sendMessage('再说一个字：行');

    let overlapFound = false;
    for (let tick = 0; tick < 20; tick++) {
      await sleep(500);
      const rects = await getMessageBoundingRects();

      // Check ALL consecutive user→assistant pairs
      for (let i = 0; i < rects.length - 1; i++) {
        if (rects[i].role === 'user' && rects[i + 1].role === 'assistant') {
          const overlap = rects[i].bottom - rects[i + 1].top;
          if (overlap > 1) {
            overlapFound = true;
            await takeScreenshot('/tmp/overlap-rapid.png');
            console.log('[overlap] OVERLAP in rapid messages at pair', i, '/', i + 1, 'overlap:', overlap, 'px');
            break;
          }
        }
      }
      if (overlapFound) break;

      const isStreaming = await executeJs(`${STORE}.streaming.getState().streamingMessageId !== null`);
      if (isStreaming === 'false') break;
    }

    expect(overlapFound).toBe(false);
  }, 90_000);
});

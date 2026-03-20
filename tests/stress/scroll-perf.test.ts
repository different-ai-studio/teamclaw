/**
 * Scroll performance test for long conversation history within a single session.
 *
 * Measures rendering and scrolling performance as message count grows
 * past the virtual-scroll threshold (50 messages).
 *
 * Requires `pnpm tauri dev` running (dev mode exposes __TEAMCLAW_STORES__).
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  executeJs,
  focusWindow,
} from '../_utils/tauri-mcp-test-utils';
import {
  verifyStoreExposed,
  isOpenCodeReady,
  createSession,
  sendMessage,
  waitForMessageCount,
  getMessageCount,
  archiveSession,
} from './stress-helpers';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const STORE = 'window.__TEAMCLAW_STORES__';
const REPORT_DIR = join(process.cwd(), 'tests/stress/reports');

// Message counts at which we take measurements.
// 50 is the VIRTUAL_MSG_THRESHOLD in MessageList.tsx.
const CHECKPOINTS = [10, 30, 50, 80, 120];
const PROMPT = 'reply with just the word hello';

interface CheckpointResult {
  messageCount: number;
  /** Time to scroll from top to bottom (ms) */
  scrollTopToBottomMs: number;
  /** Time to scroll from bottom to top (ms) */
  scrollBottomToTopMs: number;
  /** requestAnimationFrame round-trip (2x rAF, ms) */
  frameDurationMs: number | null;
  /** Container scrollHeight in px */
  scrollHeightPx: number | null;
  /** Whether virtual scrolling is active (> 50 msgs) */
  isVirtualized: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Measure 2x rAF round-trip in the webview.
 * Since executeJs eval cannot await Promises, we use a polling approach:
 * store the result in a global, then read it.
 */
async function measureFrameTime(): Promise<number | null> {
  try {
    // Start the async measurement
    await executeJs(`
      (() => {
        window.__perf_frame = null;
        const s = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__perf_frame = performance.now() - s;
        }));
      })()
    `);
    // Wait for 2x rAF to complete
    await sleep(200);
    const raw = await executeJs(`String(window.__perf_frame)`);
    const val = parseFloat(raw);
    return isNaN(val) ? null : val;
  } catch { return null; }
}

/** Get scroll container metrics */
async function getScrollMetrics(): Promise<{ scrollHeight: number; clientHeight: number } | null> {
  try {
    const raw = await executeJs(`
      (() => {
        const el = document.querySelector('[data-chat-messages]');
        if (!el) return 'null';
        return JSON.stringify({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      })()
    `);
    if (raw === 'null') return null;
    return JSON.parse(raw);
  } catch { return null; }
}

/**
 * Programmatically scroll the chat container and measure time to settle (2x rAF).
 * Uses global variable polling since executeJs cannot await Promises.
 */
async function measureScroll(direction: 'top' | 'bottom'): Promise<number> {
  const target = direction === 'top' ? 0 : 999999;
  try {
    await executeJs(`
      (() => {
        window.__perf_scroll = null;
        const el = document.querySelector('[data-chat-messages]');
        if (!el) { window.__perf_scroll = 0; return; }
        const start = performance.now();
        el.scrollTo({ top: ${target}, behavior: 'instant' });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__perf_scroll = performance.now() - start;
        }));
      })()
    `);
    await sleep(200);
    const raw = await executeJs(`String(window.__perf_scroll)`);
    const val = parseFloat(raw);
    return isNaN(val) ? 0 : val;
  } catch { return -1; }
}

describe('Message list scroll performance', () => {
  let ready = false;
  let sessionId: string | null = null;
  const results: CheckpointResult[] = [];

  beforeAll(async () => {
    await launchTeamClawApp();
    console.log('[scroll-perf] App launched, waiting for webview...');

    let storeOk = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(2_000);
      try {
        await focusWindow();
        storeOk = await verifyStoreExposed();
        if (storeOk) break;
      } catch (err: any) {
        console.log(`[scroll-perf] Waiting... attempt ${attempt + 1}/30`);
      }
    }
    if (!storeOk) throw new Error('Store not exposed after 60s');

    for (let i = 0; i < 30; i++) {
      if (await isOpenCodeReady()) { ready = true; break; }
      await sleep(2_000);
    }
    if (!ready) throw new Error('OpenCode not ready within 60s');

    // Create a single session for the entire test
    sessionId = await createSession();
    if (!sessionId) throw new Error('Failed to create session');

    console.log(`[scroll-perf] Ready. Session: ${sessionId}`);
  }, 120_000);

  afterAll(async () => {
    // Write report
    try {
      mkdirSync(REPORT_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = join(REPORT_DIR, `scroll-perf-${ts}.json`);
      writeFileSync(reportPath, JSON.stringify({ results }, null, 2));
      console.log(`[scroll-perf] Report: ${reportPath}`);
    } catch (err: any) {
      console.error('[scroll-perf] Failed to write report:', err.message);
    }

    // Cleanup
    if (sessionId) {
      try { await archiveSession(sessionId); } catch { /* ok */ }
    }
    await stopApp();
  }, 60_000);

  it('measures scroll performance as conversation grows', async () => {
    expect(ready).toBe(true);
    expect(sessionId).toBeTruthy();

    let currentCount = 0;

    for (const checkpoint of CHECKPOINTS) {
      // Send messages until we reach the checkpoint
      const needed = checkpoint - currentCount;
      if (needed > 0) {
        console.log(`[scroll-perf] Sending ${needed} messages to reach ${checkpoint}...`);
        // Each sendMessage sends 1 user msg, expect 1 assistant reply = 2 msgs per round
        const rounds = Math.ceil(needed / 2);
        for (let i = 0; i < rounds; i++) {
          try {
            await sendMessage(PROMPT);
            const expectedCount = currentCount + (i + 1) * 2;
            await waitForMessageCount(sessionId!, expectedCount, 30_000);
          } catch (err: any) {
            console.warn(`[scroll-perf] Message ${i + 1}/${rounds} failed: ${err.message?.slice(0, 80)}`);
            // Continue — we measure with whatever count we have
          }
        }
        currentCount = await getMessageCount(sessionId!);
        console.log(`[scroll-perf] Current message count: ${currentCount}`);
      }

      // Wait for UI to settle
      await sleep(2000);

      // Take measurements
      const isVirtualized = currentCount > 50;

      // Scroll to top first, then measure top→bottom
      await measureScroll('top');
      await sleep(300);
      const scrollDownMs = await measureScroll('bottom');
      await sleep(300);

      // Measure bottom→top
      const scrollUpMs = await measureScroll('top');
      await sleep(300);

      // Frame time
      const frameDurationMs = await measureFrameTime();

      // Scroll height
      const metrics = await getScrollMetrics();

      const result: CheckpointResult = {
        messageCount: currentCount,
        scrollTopToBottomMs: Math.round(scrollDownMs * 100) / 100,
        scrollBottomToTopMs: Math.round(scrollUpMs * 100) / 100,
        frameDurationMs: frameDurationMs ? Math.round(frameDurationMs * 100) / 100 : null,
        scrollHeightPx: metrics?.scrollHeight ?? null,
        isVirtualized,
      };
      results.push(result);

      console.log(
        `[scroll-perf] ${currentCount} msgs (${isVirtualized ? 'virtual' : 'DOM'}): ` +
        `scroll↓=${result.scrollTopToBottomMs}ms, scroll↑=${result.scrollBottomToTopMs}ms, ` +
        `frame=${result.frameDurationMs ?? 'N/A'}ms, height=${result.scrollHeightPx ?? 'N/A'}px`
      );
    }

    // Print summary
    console.log('\n[scroll-perf] === SUMMARY ===');
    console.log('Messages | Mode    | Scroll ↓   | Scroll ↑   | Frame Time | Height');
    console.log('---------|---------|------------|------------|------------|--------');
    for (const r of results) {
      const mode = r.isVirtualized ? 'virtual' : 'DOM    ';
      console.log(
        `${String(r.messageCount).padStart(8)} | ${mode} | ` +
        `${String(r.scrollTopToBottomMs + 'ms').padStart(10)} | ` +
        `${String(r.scrollBottomToTopMs + 'ms').padStart(10)} | ` +
        `${String((r.frameDurationMs ?? 'N/A') + 'ms').padStart(10)} | ` +
        `${String(r.scrollHeightPx ?? 'N/A').padStart(6)}`
      );
    }

    // Assertions: scroll should remain reasonable even at 120 msgs
    const last = results[results.length - 1];
    if (last && last.frameDurationMs !== null) {
      // Frame time should stay under 100ms (below jank threshold)
      expect(last.frameDurationMs).toBeLessThan(100);
    }
    if (last) {
      // Scroll operations should complete within 500ms
      expect(last.scrollTopToBottomMs).toBeLessThan(500);
      expect(last.scrollBottomToTopMs).toBeLessThan(500);
    }
  }, 600_000);
});

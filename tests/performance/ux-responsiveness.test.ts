/**
 * UX Responsiveness Benchmark
 *
 * Pure benchmark — no pass/fail assertions, only data collection.
 * Reports: tests/performance/reports/ux-responsiveness-<ts>.json
 *
 * Run: TEAMCLAW_APP_PATH=<path> pnpm test:e2e:performance tests/performance/ux-responsiveness.test.ts
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  executeJs,
  focusWindow,
} from '../_utils/tauri-mcp-test-utils';
import {
  createSession,
  archiveSession,
} from '../stress/stress-helpers';

const REPORT_DIR = join(process.cwd(), 'tests/performance/reports');

const report: Record<string, unknown> = {};
const createdSessions: string[] = [];

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100;
}

async function measureRenderMs(htmlContent: string, trials = 5): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < trials; i++) {
    try {
      await executeJs(`(() => { const e = document.getElementById('__perf_overlay'); if (e) e.remove(); })()`);
    } catch { /* ok */ }
    const escaped = JSON.stringify(htmlContent);
    await executeJs(`
      (() => {
        window.__perf_render = null;
        const container = document.querySelector('[data-chat-messages]') || document.body;
        const overlay = document.createElement('div');
        overlay.id = '__perf_overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#fff;overflow:auto;pointer-events:none';
        const t = performance.now();
        overlay.innerHTML = ${escaped};
        container.appendChild(overlay);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__perf_render = performance.now() - t;
          const el = document.getElementById('__perf_overlay');
          if (el) el.remove();
        }));
      })()
    `);
    await sleep(500);
    const raw = await executeJs('String(window.__perf_render)');
    const val = parseFloat(raw);
    if (!isNaN(val)) times.push(Math.round(val * 100) / 100);
    await sleep(200);
  }
  return times;
}

function generatePlainTextHtml(): string {
  const sentence = 'The quick brown fox jumps over the lazy dog near the riverbank. ';
  const repeated = sentence.repeat(Math.ceil(5000 / sentence.length)).slice(0, 5000);
  return `<div style="padding:16px;font-size:14px;line-height:1.6;color:#333">${repeated}</div>`;
}

function generateCodeBlockHtml(): string {
  const tokenLine = (n: number) =>
    `<span class="line">` +
    `<span style="color:#F97583">const</span> ` +
    `<span style="color:#E1E4E8">value${n}</span>` +
    `<span style="color:#F97583"> =</span> ` +
    `<span style="color:#B392F0">processInput</span>` +
    `<span style="color:#E1E4E8">(</span>` +
    `<span style="color:#79B8FF">${n}</span>` +
    `<span style="color:#E1E4E8">);</span>` +
    `</span>`;
  const lines: string[] = [];
  let total = 0;
  let i = 0;
  while (total < 4800) {
    const line = tokenLine(i);
    lines.push(line);
    total += line.length;
    i++;
  }
  return `<pre style="background:#0d1117;padding:16px;overflow:auto;font-size:13px"><code class="language-typescript">${lines.join('\n')}</code></pre>`;
}

describe('UX Responsiveness', () => {
  let launchStart = 0;

  beforeAll(async () => {
    launchStart = Date.now();
    await launchTeamClawApp();
    await focusWindow();

    let ttiElapsed: number | null = null;
    let storeReady = false;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      try {
        const ready = await executeJs(`
          (() => {
            const storeOk = typeof window.__TEAMCLAW_STORES__?.session?.getState === 'function';
            const inputOk = !!document.querySelector('[data-testid="chat-input-area"]');
            return String(storeOk && inputOk);
          })()
        `);
        if (ready === 'true') {
          ttiElapsed = Date.now() - launchStart;
          storeReady = true;
          break;
        }
      } catch { /* keep polling */ }
    }
    if (!storeReady) console.warn('[ux-perf] WARNING: store not accessible after 60s — scenarios may fail');

    let fcpMs: number | null = null;
    try {
      const raw = await executeJs(`
        (() => {
          const entries = performance.getEntriesByType('paint');
          const fcp = entries.find(e => e.name === 'first-contentful-paint');
          return fcp ? String(Math.round(fcp.startTime * 100) / 100) : 'null';
        })()
      `);
      if (raw !== 'null') fcpMs = parseFloat(raw);
    } catch { /* fcp unavailable */ }

    report.coldFcp = { valueMs: fcpMs, note: 'relative to webview navigation start' };
    report.coldTti = { valueMs: ttiElapsed, note: 'from process spawn to store+input ready' };
    console.log(`[ux-perf] COLD FCP: ${fcpMs}ms | TTI: ${ttiElapsed}ms`);
  }, 180_000);

  afterAll(async () => {
    for (const id of createdSessions) {
      try { await archiveSession(id); } catch { /* ok */ }
    }
    try {
      mkdirSync(REPORT_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const path = join(REPORT_DIR, `ux-responsiveness-${ts}.json`);
      const payload = { date: new Date().toISOString(), scenarios: report };
      writeFileSync(path, JSON.stringify(payload, null, 2));
      console.log(`\n[ux-perf] Report: ${path}`);
      console.log(JSON.stringify(payload, null, 2));
    } catch (err: unknown) {
      console.error('[ux-perf] Failed to write report:', (err as Error).message);
    }
    try { await stopApp(); } catch (err: unknown) { console.warn('[ux-perf] stopApp error:', (err as Error).message); }
  }, 60_000);

  it('COLD-01: cold start FCP', () => {
    console.log(`[ux-perf] FCP = ${(report.coldFcp as any)?.valueMs}ms`);
  });

  it('COLD-02: cold start TTI', () => {
    console.log(`[ux-perf] TTI = ${(report.coldTti as any)?.valueMs}ms`);
  });

  it('HOT-01: hot render FCP/TTI', async () => {
    const sessionId = await createSession();
    if (!sessionId) {
      console.warn('[ux-perf] HOT-01: could not create session, skipping');
      report.hotRender = { valueMs: null, note: 'session creation failed' };
      return;
    }
    createdSessions.push(sessionId);

    await executeJs(`
      window.__perf_hot = null;
      window.__perf_hot_fired = false;
      window.__perf_hot_t0 = performance.now();
    `);
    await executeJs(
      `window.__TEAMCLAW_STORES__.session.getState().setActiveSession(${JSON.stringify(sessionId)})`
    );

    let hotMs: number | null = null;
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      const result = await executeJs(`
        (() => {
          if (window.__perf_hot !== null) return String(window.__perf_hot);
          const active = window.__TEAMCLAW_STORES__.session.getState().activeSessionId;
          const el = document.querySelector('[data-chat-messages]');
          if (active === ${JSON.stringify(sessionId)} && el && !window.__perf_hot_fired) {
            window.__perf_hot_fired = true;
            requestAnimationFrame(() => requestAnimationFrame(() => {
              window.__perf_hot = performance.now() - window.__perf_hot_t0;
            }));
          }
          return 'waiting';
        })()
      `);
      const val = parseFloat(result);
      if (!isNaN(val)) { hotMs = Math.round(val * 100) / 100; break; }
    }

    report.hotRender = { valueMs: hotMs };
    console.log(`[ux-perf] HOT-01: ${hotMs}ms`);
  }, 30_000);

  it('SESSION-01: session switch latency', async () => {
    const sessionA = await createSession();
    const sessionB = await createSession();
    if (!sessionA || !sessionB) {
      console.warn('[ux-perf] SESSION-01: session creation failed, skipping');
      report.sessionSwitch = { skipped: true };
      return;
    }
    createdSessions.push(sessionA, sessionB);

    const targets = [sessionB, sessionA, sessionB, sessionA, sessionB];
    const times: number[] = [];

    for (const targetId of targets) {
      await executeJs(`
        window.__perf_switch = null;
        window.__perf_switch_fired = false;
        window.__perf_switch_t0 = performance.now();
      `);
      await executeJs(
        `window.__TEAMCLAW_STORES__.session.getState().setActiveSession(${JSON.stringify(targetId)})`
      );

      for (let i = 0; i < 30; i++) {
        await sleep(150);
        const result = await executeJs(`
          (() => {
            if (window.__perf_switch !== null) return String(window.__perf_switch);
            const active = window.__TEAMCLAW_STORES__.session.getState().activeSessionId;
            if (active === ${JSON.stringify(targetId)} && !window.__perf_switch_fired) {
              window.__perf_switch_fired = true;
              requestAnimationFrame(() => requestAnimationFrame(() => {
                window.__perf_switch = performance.now() - window.__perf_switch_t0;
              }));
            }
            return 'waiting';
          })()
        `);
        const val = parseFloat(result);
        if (!isNaN(val)) { times.push(Math.round(val * 100) / 100); break; }
      }
      await sleep(400);
    }

    const sorted = [...times].sort((a, b) => a - b);
    report.sessionSwitch = {
      trials: times,
      min: sorted[0] ?? null,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: sorted[sorted.length - 1] ?? null,
    };
    console.log(
      `[ux-perf] SESSION-01: min=${sorted[0]}ms p50=${percentile(times, 50)}ms p95=${percentile(times, 95)}ms max=${sorted[sorted.length - 1]}ms`
    );
  }, 60_000);

  it('INPUT-01: input response delay', async () => {
    const times: number[] = [];

    for (let i = 0; i < 20; i++) {
      await executeJs(`
        (() => {
          window.__perf_input = null;
          const el = document.querySelector('[data-testid="chat-input-area"] [contenteditable]');
          if (!el) { window.__perf_input = -1; return; }
          el.focus();
          const t = performance.now();
          document.execCommand('insertText', false, 'x');
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.__perf_input = performance.now() - t;
          }));
        })()
      `);
      await sleep(300);
      const raw = await executeJs('String(window.__perf_input)');
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) times.push(Math.round(val * 100) / 100);
      await sleep(100);
      try {
        await executeJs(`
          (() => {
            const el = document.querySelector('[data-testid="chat-input-area"] [contenteditable]');
            if (!el) return;
            el.focus();
            document.execCommand('selectAll', false, undefined);
            document.execCommand('delete', false, undefined);
          })()
        `);
      } catch { /* ok */ }
    }

    report.inputDelay = {
      trials: times,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      max: times.length > 0 ? Math.max(...times) : null,
      note: 'execCommand insertText + double-rAF in Tiptap contenteditable',
    };
    console.log(
      `[ux-perf] INPUT-01: p50=${percentile(times, 50)}ms p95=${percentile(times, 95)}ms max=${times.length > 0 ? Math.max(...times) : null}ms (${times.length} trials)`
    );
  }, 60_000);

  it('RENDER-01: large plain text render', async () => {
    const baselineTimes = await measureRenderMs('<div></div>');
    const baselineMean = mean(baselineTimes);
    const plainTimes = await measureRenderMs(generatePlainTextHtml());
    const plainMean = mean(plainTimes);
    report.renderPlainText = {
      trials: plainTimes,
      meanMs: plainMean,
      maxMs: plainTimes.length > 0 ? Math.max(...plainTimes) : null,
      baselineMeanMs: baselineMean,
      deltaVsBaselineMs: Math.round((plainMean - baselineMean) * 100) / 100,
    };
    console.log(
      `[ux-perf] RENDER-01: mean=${plainMean}ms max=${plainTimes.length > 0 ? Math.max(...plainTimes) : null}ms delta=${Math.round((plainMean - baselineMean) * 100) / 100}ms vs baseline`
    );
  }, 30_000);

  it('RENDER-02: large code block render', async () => {
    const baselineTimes = await measureRenderMs('<div></div>');
    const baselineMean = mean(baselineTimes);
    const codeTimes = await measureRenderMs(generateCodeBlockHtml());
    const codeMean = mean(codeTimes);
    report.renderCodeBlock = {
      trials: codeTimes,
      meanMs: codeMean,
      maxMs: codeTimes.length > 0 ? Math.max(...codeTimes) : null,
      baselineMeanMs: baselineMean,
      deltaVsBaselineMs: Math.round((codeMean - baselineMean) * 100) / 100,
      note: 'pre-rendered Shiki-style HTML; tests DOM paint, not Shiki parse',
    };
    console.log(
      `[ux-perf] RENDER-02: mean=${codeMean}ms max=${codeTimes.length > 0 ? Math.max(...codeTimes) : null}ms delta=${Math.round((codeMean - baselineMean) * 100) / 100}ms vs baseline`
    );
  }, 30_000);
});

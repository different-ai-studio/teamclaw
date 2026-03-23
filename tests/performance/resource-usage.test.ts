/**
 * Performance: Resource Usage Test
 *
 * Simulates real usage scenarios while monitoring CPU and memory.
 * Requires the app to be running (pnpm tauri dev).
 *
 * Scenarios:
 *   1. Idle baseline — app open, no activity
 *   2. Single conversation — send messages and wait for responses
 *   3. Rapid interactions — fast sequential messages
 *   4. Multi-session — multiple concurrent sessions
 *   5. Settings navigation — open/close settings panels
 *   6. Long idle — extended idle after activity
 *
 * Run: npx vitest run tests/performance/resource-usage.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  executeJs,
  waitForCondition,
  getOsPid,
} from '../_utils/tauri-mcp-test-utils';

// ── Types ────────────────────────────────────────────────────────────

interface ProcessSample {
  timestamp: number;
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMB: number;
  rss: number;
}

interface ScenarioResult {
  name: string;
  duration: number;
  samples: ProcessSample[];
  avgCpu: number;
  maxCpu: number;
  avgMemoryMB: number;
  maxMemoryMB: number;
  minMemoryMB: number;
  memoryDeltaMB: number; // end - start
}

// ── Process Monitoring ───────────────────────────────────────────────

function sampleProcesses(): ProcessSample[] {
  const now = Date.now();
  const samples: ProcessSample[] = [];

  try {
    // Get all TeamClaw-related processes
    const raw = execSync(
      `ps -eo pid,pcpu,rss,comm | grep -iE "teamclaw|opencode|WebKit" | grep -v grep`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;

      const pid = parseInt(parts[0]);
      const cpu = parseFloat(parts[1]);
      const rss = parseInt(parts[2]); // KB
      const name = parts.slice(3).join(' ').split('/').pop() || 'unknown';

      if (isNaN(pid)) continue;

      samples.push({
        timestamp: now,
        pid,
        name,
        cpuPercent: cpu,
        memoryMB: Math.round((rss / 1024) * 100) / 100,
        rss,
      });
    }
  } catch {
    // No matching processes
  }

  return samples;
}

function aggregateSamples(samples: ProcessSample[]): {
  totalCpu: number;
  totalMemoryMB: number;
} {
  let totalCpu = 0;
  let totalMemoryMB = 0;

  // Group by timestamp and sum within each timestamp
  const byTimestamp = new Map<number, ProcessSample[]>();
  for (const s of samples) {
    const arr = byTimestamp.get(s.timestamp) || [];
    arr.push(s);
    byTimestamp.set(s.timestamp, arr);
  }

  // Use the latest timestamp's data
  const latest = Math.max(...byTimestamp.keys());
  const latestSamples = byTimestamp.get(latest) || [];

  for (const s of latestSamples) {
    totalCpu += s.cpuPercent;
    totalMemoryMB += s.memoryMB;
  }

  return { totalCpu, totalMemoryMB };
}

// ── Sampling Loop ────────────────────────────────────────────────────

async function monitorDuring(
  durationMs: number,
  intervalMs: number = 1000,
): Promise<ProcessSample[]> {
  const allSamples: ProcessSample[] = [];
  const end = Date.now() + durationMs;

  while (Date.now() < end) {
    allSamples.push(...sampleProcesses());
    await sleep(intervalMs);
  }

  return allSamples;
}

function computeStats(
  samples: ProcessSample[],
  scenarioName: string,
  durationMs: number,
): ScenarioResult {
  // Group samples by timestamp to get total CPU/mem at each point
  const byTimestamp = new Map<number, { cpu: number; mem: number }>();
  for (const s of samples) {
    const entry = byTimestamp.get(s.timestamp) || { cpu: 0, mem: 0 };
    entry.cpu += s.cpuPercent;
    entry.mem += s.memoryMB;
    byTimestamp.set(s.timestamp, entry);
  }

  const points = [...byTimestamp.values()];
  if (points.length === 0) {
    return {
      name: scenarioName,
      duration: durationMs,
      samples,
      avgCpu: 0, maxCpu: 0,
      avgMemoryMB: 0, maxMemoryMB: 0, minMemoryMB: 0,
      memoryDeltaMB: 0,
    };
  }

  const cpus = points.map(p => p.cpu);
  const mems = points.map(p => p.mem);

  return {
    name: scenarioName,
    duration: durationMs,
    samples,
    avgCpu: Math.round((cpus.reduce((a, b) => a + b, 0) / cpus.length) * 100) / 100,
    maxCpu: Math.round(Math.max(...cpus) * 100) / 100,
    avgMemoryMB: Math.round((mems.reduce((a, b) => a + b, 0) / mems.length) * 100) / 100,
    maxMemoryMB: Math.round(Math.max(...mems) * 100) / 100,
    minMemoryMB: Math.round(Math.min(...mems) * 100) / 100,
    memoryDeltaMB: Math.round((mems[mems.length - 1] - mems[0]) * 100) / 100,
  };
}

// ── OpenCode API Helpers ─────────────────────────────────────────────

async function isOpenCodeReady(): Promise<boolean> {
  try {
    const result = await executeJs(`
      (() => {
        try {
          const s = window.__TEAMCLAW_STORES__?.session?.getState();
          return s?.isConnected ? 'true' : 'false';
        } catch { return 'false'; }
      })()
    `);
    return result === 'true';
  } catch {
    return false;
  }
}

async function createSession(): Promise<string | null> {
  try {
    const result = await executeJs(`
      (async () => {
        try {
          const s = window.__TEAMCLAW_STORES__?.session?.getState();
          if (!s) return 'null';
          const id = await s.createSession();
          return id || 'null';
        } catch(e) { return 'error:' + e.message; }
      })()
    `);
    return result && result !== 'null' && !result.startsWith('error:') ? result : null;
  } catch {
    return null;
  }
}

async function sendMessage(text: string): Promise<boolean> {
  try {
    const result = await executeJs(`
      (async () => {
        try {
          const s = window.__TEAMCLAW_STORES__?.session?.getState();
          if (!s) return 'no-store';
          await s.sendMessage(${JSON.stringify(text)});
          return 'ok';
        } catch(e) { return 'error:' + e.message; }
      })()
    `);
    return result === 'ok';
  } catch {
    return false;
  }
}

async function getMessageCount(): Promise<number> {
  try {
    const result = await executeJs(`
      (() => {
        try {
          const s = window.__TEAMCLAW_STORES__?.session?.getState();
          if (!s || !s.activeSessionId) return '0';
          const msgs = s.getSessionMessages?.() || [];
          return String(msgs.length);
        } catch { return '0'; }
      })()
    `);
    return parseInt(result) || 0;
  } catch {
    return 0;
  }
}

async function waitForResponse(timeoutMs: number = 60000): Promise<boolean> {
  const startCount = await getMessageCount();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await getMessageCount();
    // We expect at least 2 new messages (assistant response parts)
    if (count > startCount) return true;
    await sleep(1000);
  }
  return false;
}

async function archiveSession(): Promise<void> {
  try {
    await executeJs(`
      (async () => {
        const s = window.__TEAMCLAW_STORES__?.session?.getState();
        if (s?.activeSessionId) await s.archiveSession(s.activeSessionId);
      })()
    `);
  } catch { /* ignore */ }
}

// ── Test Suite ───────────────────────────────────────────────────────

describe('Performance: Resource Usage', () => {
  const results: ScenarioResult[] = [];
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();

      // Wait for OpenCode to be ready
      for (let i = 0; i < 30; i++) {
        if (await isOpenCodeReady()) {
          appReady = true;
          break;
        }
        await sleep(2000);
      }

      if (!appReady) {
        console.warn('[perf] OpenCode not ready after 60s, tests will be limited');
      }
    } catch (err: unknown) {
      console.error('[perf] Failed to launch app:', (err as Error).message);
    }
  }, 120_000);

  afterAll(async () => {
    // Generate report
    generateReport(results);
  }, 30_000);

  // ── Scenario 1: Idle Baseline ────────────────────────────────────

  it('SCENARIO-01: Idle baseline (15s)', async () => {
    console.log('\n📊 Measuring idle baseline...');
    const samples = await monitorDuring(15_000, 1000);
    const stats = computeStats(samples, 'Idle Baseline', 15_000);
    results.push(stats);

    console.log(`   CPU avg: ${stats.avgCpu}% | max: ${stats.maxCpu}%`);
    console.log(`   MEM avg: ${stats.avgMemoryMB}MB | max: ${stats.maxMemoryMB}MB`);

    // Idle CPU should be under 20%
    expect(stats.avgCpu).toBeLessThan(20);
  }, 30_000);

  // ── Scenario 2: Single Conversation ──────────────────────────────

  it('SCENARIO-02: Single conversation (send 3 messages)', async () => {
    if (!appReady) return;

    console.log('\n📊 Measuring single conversation...');

    const sessionId = await createSession();
    expect(sessionId).toBeTruthy();
    await sleep(1000);

    const startTime = Date.now();
    const allSamples: ProcessSample[] = [];

    const prompts = [
      'Say hello in one sentence.',
      'What is 2 + 2? Answer in one word.',
      'Say goodbye in one sentence.',
    ];

    for (const prompt of prompts) {
      console.log(`   Sending: "${prompt}"`);
      const sent = await sendMessage(prompt);
      if (!sent) {
        console.warn('   Failed to send message, skipping');
        continue;
      }

      // Monitor while waiting for response
      const responseStart = Date.now();
      const responded = await Promise.race([
        waitForResponse(30_000),
        (async () => {
          while (Date.now() - responseStart < 30_000) {
            allSamples.push(...sampleProcesses());
            await sleep(1000);
          }
          return false;
        })(),
      ]);

      // Collect remaining samples
      allSamples.push(...sampleProcesses());
      await sleep(2000);
    }

    const duration = Date.now() - startTime;
    const stats = computeStats(allSamples, 'Single Conversation', duration);
    results.push(stats);

    console.log(`   Duration: ${Math.round(duration / 1000)}s`);
    console.log(`   CPU avg: ${stats.avgCpu}% | max: ${stats.maxCpu}%`);
    console.log(`   MEM avg: ${stats.avgMemoryMB}MB | max: ${stats.maxMemoryMB}MB`);
    console.log(`   MEM delta: ${stats.memoryDeltaMB > 0 ? '+' : ''}${stats.memoryDeltaMB}MB`);

    await archiveSession();
  }, 180_000);

  // ── Scenario 3: Rapid Interactions ───────────────────────────────

  it('SCENARIO-03: Rapid interactions (5 quick messages)', async () => {
    if (!appReady) return;

    console.log('\n📊 Measuring rapid interactions...');

    const sessionId = await createSession();
    expect(sessionId).toBeTruthy();
    await sleep(1000);

    const startTime = Date.now();
    const allSamples: ProcessSample[] = [];

    // Send messages rapidly without waiting for full response
    for (let i = 0; i < 5; i++) {
      await sendMessage(`Quick test ${i + 1}: respond with just "ok ${i + 1}"`);
      allSamples.push(...sampleProcesses());
      await sleep(500);
    }

    // Now monitor while responses come in
    const monitorSamples = await monitorDuring(20_000, 1000);
    allSamples.push(...monitorSamples);

    const duration = Date.now() - startTime;
    const stats = computeStats(allSamples, 'Rapid Interactions', duration);
    results.push(stats);

    console.log(`   Duration: ${Math.round(duration / 1000)}s`);
    console.log(`   CPU avg: ${stats.avgCpu}% | max: ${stats.maxCpu}%`);
    console.log(`   MEM avg: ${stats.avgMemoryMB}MB | max: ${stats.maxMemoryMB}MB`);

    await archiveSession();
  }, 120_000);

  // ── Scenario 4: Multi-Session ────────────────────────────────────

  it('SCENARIO-04: Multi-session (create 3 sessions)', async () => {
    if (!appReady) return;

    console.log('\n📊 Measuring multi-session...');

    const startTime = Date.now();
    const allSamples: ProcessSample[] = [];
    const sessionIds: string[] = [];

    // Memory before
    allSamples.push(...sampleProcesses());

    for (let i = 0; i < 3; i++) {
      const sid = await createSession();
      if (sid) sessionIds.push(sid);
      await sleep(500);
      allSamples.push(...sampleProcesses());

      await sendMessage(`Session ${i + 1}: say "hello from session ${i + 1}" in one line.`);
      await sleep(3000);
      allSamples.push(...sampleProcesses());
    }

    // Wait for all responses
    const monitorSamples = await monitorDuring(15_000, 1000);
    allSamples.push(...monitorSamples);

    const duration = Date.now() - startTime;
    const stats = computeStats(allSamples, 'Multi-Session', duration);
    results.push(stats);

    console.log(`   Sessions created: ${sessionIds.length}`);
    console.log(`   Duration: ${Math.round(duration / 1000)}s`);
    console.log(`   CPU avg: ${stats.avgCpu}% | max: ${stats.maxCpu}%`);
    console.log(`   MEM avg: ${stats.avgMemoryMB}MB | max: ${stats.maxMemoryMB}MB`);
    console.log(`   MEM delta: ${stats.memoryDeltaMB > 0 ? '+' : ''}${stats.memoryDeltaMB}MB`);

    // Cleanup
    for (const sid of sessionIds) {
      try {
        await executeJs(`
          window.__TEAMCLAW_STORES__?.session?.getState()?.archiveSession('${sid}')
        `);
      } catch { /* ignore */ }
    }
  }, 180_000);

  // ── Scenario 5: Settings Navigation ──────────────────────────────

  it('SCENARIO-05: Settings navigation', async () => {
    if (!appReady) return;

    console.log('\n📊 Measuring settings navigation...');

    const startTime = Date.now();
    const allSamples: ProcessSample[] = [];

    const sections = ['general', 'llm', 'prompt', 'voice', 'permissions', 'about'];

    for (const section of sections) {
      await executeJs(`
        (() => {
          // Simulate opening settings via keyboard shortcut or direct state update
          const el = document.querySelector('[data-settings-section="${section}"]');
          if (el) el.click();
        })()
      `);
      await sleep(800);
      allSamples.push(...sampleProcesses());
    }

    // Close settings
    await sleep(1000);
    allSamples.push(...sampleProcesses());

    const duration = Date.now() - startTime;
    const stats = computeStats(allSamples, 'Settings Navigation', duration);
    results.push(stats);

    console.log(`   Duration: ${Math.round(duration / 1000)}s`);
    console.log(`   CPU avg: ${stats.avgCpu}% | max: ${stats.maxCpu}%`);
    console.log(`   MEM avg: ${stats.avgMemoryMB}MB | max: ${stats.maxMemoryMB}MB`);
  }, 60_000);

  // ── Scenario 6: Post-Activity Idle ───────────────────────────────

  it('SCENARIO-06: Post-activity idle (15s)', async () => {
    console.log('\n📊 Measuring post-activity idle...');
    const samples = await monitorDuring(15_000, 1000);
    const stats = computeStats(samples, 'Post-Activity Idle', 15_000);
    results.push(stats);

    console.log(`   CPU avg: ${stats.avgCpu}% | max: ${stats.maxCpu}%`);
    console.log(`   MEM avg: ${stats.avgMemoryMB}MB | max: ${stats.maxMemoryMB}MB`);

    // Compare with initial idle
    if (results.length > 1 && results[0].name === 'Idle Baseline') {
      const delta = stats.avgMemoryMB - results[0].avgMemoryMB;
      console.log(`   MEM vs baseline: ${delta > 0 ? '+' : ''}${Math.round(delta * 100) / 100}MB`);
    }
  }, 30_000);
});

// ── Report Generator ─────────────────────────────────────────────────

function generateReport(results: ScenarioResult[]) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = `/tmp/teamclaw-perf-${timestamp}.json`;
  const htmlPath = `/tmp/teamclaw-perf-${timestamp}.html`;

  // JSON report
  const jsonReport = {
    timestamp: new Date().toISOString(),
    system: getSystemInfo(),
    scenarios: results.map(r => ({
      name: r.name,
      duration: r.duration,
      cpu: { avg: r.avgCpu, max: r.maxCpu },
      memory: {
        avg: r.avgMemoryMB,
        max: r.maxMemoryMB,
        min: r.minMemoryMB,
        delta: r.memoryDeltaMB,
      },
      sampleCount: r.samples.length,
    })),
  };

  writeFileSync(reportPath, JSON.stringify(jsonReport, null, 2));

  // HTML report
  const html = generateHtmlReport(results, jsonReport.system);
  writeFileSync(htmlPath, html);

  console.log('\n' + '═'.repeat(60));
  console.log('  PERFORMANCE TEST REPORT');
  console.log('═'.repeat(60));
  console.log(`  Date: ${new Date().toLocaleString()}`);
  console.log(`  System: ${jsonReport.system.os} | ${jsonReport.system.cpu} | ${jsonReport.system.memory}`);
  console.log('─'.repeat(60));

  for (const r of results) {
    console.log(`\n  ${r.name}`);
    console.log(`    Duration:   ${Math.round(r.duration / 1000)}s`);
    console.log(`    CPU:        avg ${r.avgCpu}% | max ${r.maxCpu}%`);
    console.log(`    Memory:     avg ${r.avgMemoryMB}MB | max ${r.maxMemoryMB}MB`);
    if (r.memoryDeltaMB !== 0) {
      console.log(`    Mem Delta:  ${r.memoryDeltaMB > 0 ? '+' : ''}${r.memoryDeltaMB}MB`);
    }
  }

  // Summary
  const allMaxCpu = Math.max(...results.map(r => r.maxCpu));
  const allMaxMem = Math.max(...results.map(r => r.maxMemoryMB));
  const idleBaseline = results.find(r => r.name === 'Idle Baseline');
  const postIdle = results.find(r => r.name === 'Post-Activity Idle');

  console.log('\n' + '─'.repeat(60));
  console.log('  SUMMARY');
  console.log(`    Peak CPU:     ${allMaxCpu}%`);
  console.log(`    Peak Memory:  ${allMaxMem}MB`);
  if (idleBaseline && postIdle) {
    const leak = postIdle.avgMemoryMB - idleBaseline.avgMemoryMB;
    console.log(`    Memory Leak:  ${leak > 0 ? '+' : ''}${Math.round(leak * 100) / 100}MB (post-idle vs baseline)`);
    if (leak > 100) {
      console.log('    ⚠️  Potential memory leak detected!');
    }
  }
  console.log('═'.repeat(60));
  console.log(`  JSON: ${reportPath}`);
  console.log(`  HTML: ${htmlPath}`);
  console.log('═'.repeat(60));
}

function getSystemInfo(): { os: string; cpu: string; memory: string } {
  try {
    const os = execSync('sw_vers -productVersion', { encoding: 'utf-8' }).trim();
    const cpu = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf-8' }).trim();
    const memBytes = parseInt(execSync('sysctl -n hw.memsize', { encoding: 'utf-8' }).trim());
    const memGB = Math.round(memBytes / 1024 / 1024 / 1024);
    return { os: `macOS ${os}`, cpu, memory: `${memGB}GB` };
  } catch {
    return { os: 'unknown', cpu: 'unknown', memory: 'unknown' };
  }
}

function generateHtmlReport(results: ScenarioResult[], system: { os: string; cpu: string; memory: string }): string {
  const rows = results.map(r => `
    <tr>
      <td>${r.name}</td>
      <td>${Math.round(r.duration / 1000)}s</td>
      <td>${r.avgCpu}%</td>
      <td>${r.maxCpu}%</td>
      <td>${r.avgMemoryMB}MB</td>
      <td>${r.maxMemoryMB}MB</td>
      <td style="color:${r.memoryDeltaMB > 50 ? 'red' : r.memoryDeltaMB > 0 ? 'orange' : 'green'}">${r.memoryDeltaMB > 0 ? '+' : ''}${r.memoryDeltaMB}MB</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>TeamClaw Performance Report</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; background: #fafafa; }
  h1 { color: #1a1a1a; }
  .meta { color: #666; font-size: 14px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th { background: #f5f5f5; text-align: left; padding: 12px; font-size: 13px; color: #555; border-bottom: 2px solid #eee; }
  td { padding: 12px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f9f9f9; }
  .summary { margin-top: 20px; padding: 16px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .summary h3 { margin-top: 0; }
  .warn { color: #e67e22; font-weight: bold; }
  .ok { color: #27ae60; }
</style>
</head>
<body>
<h1>TeamClaw Performance Report</h1>
<div class="meta">
  <p>Date: ${new Date().toLocaleString()}</p>
  <p>System: ${system.os} | ${system.cpu} | ${system.memory} RAM</p>
</div>
<table>
  <thead>
    <tr>
      <th>Scenario</th>
      <th>Duration</th>
      <th>CPU Avg</th>
      <th>CPU Max</th>
      <th>Mem Avg</th>
      <th>Mem Max</th>
      <th>Mem Delta</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<div class="summary">
  <h3>Summary</h3>
  <p>Peak CPU: <strong>${Math.max(...results.map(r => r.maxCpu))}%</strong></p>
  <p>Peak Memory: <strong>${Math.max(...results.map(r => r.maxMemoryMB))}MB</strong></p>
</div>
</body>
</html>`;
}

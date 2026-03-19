import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { StressConfig } from './stress-config';

export interface InteractionRecord {
  timestamp: string;
  scenario: 'single' | 'multi' | 'mixed';
  sessionId: string;
  messageIndex: number;
  responseTimeMs: number;
  success: boolean;
  error?: {
    type: 'timeout' | 'send_error' | 'sse_error' | 'socket_error' | 'unknown';
    message: string;
    screenshot?: string;
  };
}

export interface ScenarioResult {
  totalMessages: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  successRate: number;
  avgResponseTimeMs: number;
  p50ResponseTimeMs: number;
  p95ResponseTimeMs: number;
  p99ResponseTimeMs: number;
  maxResponseTimeMs: number;
}

export interface StressReport {
  meta: {
    startTime: string;
    endTime: string;
    durationMinutes: number;
    config: StressConfig;
  };
  summary: ScenarioResult & {
    sessionsCreated: number;
    errorsByType: Record<string, number>;
  };
  scenarios: {
    singleSession: ScenarioResult;
    multiSession: ScenarioResult;
    mixed: ScenarioResult;
  };
  errors: InteractionRecord[];
  timeline: InteractionRecord[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeScenarioResult(records: InteractionRecord[]): ScenarioResult {
  if (records.length === 0) {
    return {
      totalMessages: 0, successCount: 0, failureCount: 0, timeoutCount: 0,
      successRate: 0, avgResponseTimeMs: 0, p50ResponseTimeMs: 0,
      p95ResponseTimeMs: 0, p99ResponseTimeMs: 0, maxResponseTimeMs: 0,
    };
  }
  const successes = records.filter((r) => r.success);
  const failures = records.filter((r) => !r.success);
  const timeouts = failures.filter((r) => r.error?.type === 'timeout');
  const times = successes.map((r) => r.responseTimeMs).sort((a, b) => a - b);
  const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  return {
    totalMessages: records.length,
    successCount: successes.length,
    failureCount: failures.length,
    timeoutCount: timeouts.length,
    successRate: (successes.length / records.length) * 100,
    avgResponseTimeMs: Math.round(avg),
    p50ResponseTimeMs: percentile(times, 50),
    p95ResponseTimeMs: percentile(times, 95),
    p99ResponseTimeMs: percentile(times, 99),
    maxResponseTimeMs: times.length > 0 ? times[times.length - 1] : 0,
  };
}

export class StressReporter {
  private records: InteractionRecord[] = [];
  private startTime: string;
  private sessionsCreated = 0;
  private sessionIds: string[] = [];

  constructor(private config: StressConfig) {
    this.startTime = new Date().toISOString();
  }

  record(entry: InteractionRecord): void {
    this.records.push(entry);
    const status = entry.success ? '✓' : '✗';
    const errInfo = entry.error ? ` [${entry.error.type}: ${entry.error.message.slice(0, 80)}]` : '';
    console.log(`[stress] ${status} ${entry.scenario}/${entry.sessionId.slice(0, 8)} #${entry.messageIndex} ${entry.responseTimeMs}ms${errInfo}`);
  }

  trackSessionCreated(sessionId: string): void {
    this.sessionsCreated++;
    this.sessionIds.push(sessionId);
  }

  getSessionIds(): string[] {
    return [...this.sessionIds];
  }

  generateReport(): StressReport {
    const endTime = new Date().toISOString();
    const allScenarios = {
      singleSession: computeScenarioResult(this.records.filter((r) => r.scenario === 'single')),
      multiSession: computeScenarioResult(this.records.filter((r) => r.scenario === 'multi')),
      mixed: computeScenarioResult(this.records.filter((r) => r.scenario === 'mixed')),
    };
    const overall = computeScenarioResult(this.records);
    const errorsByType: Record<string, number> = {};
    for (const r of this.records.filter((r) => !r.success)) {
      const t = r.error?.type || 'unknown';
      errorsByType[t] = (errorsByType[t] || 0) + 1;
    }
    return {
      meta: { startTime: this.startTime, endTime, durationMinutes: this.config.durationMinutes, config: this.config },
      summary: { ...overall, sessionsCreated: this.sessionsCreated, errorsByType },
      scenarios: allScenarios,
      errors: this.records.filter((r) => !r.success),
      timeline: this.records,
    };
  }

  writeReports(reportDir: string): { jsonPath: string; htmlPath: string } {
    mkdirSync(join(reportDir, 'screenshots'), { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const report = this.generateReport();

    const jsonPath = join(reportDir, `stress-${ts}.json`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    const htmlPath = join(reportDir, `stress-${ts}.html`);
    writeFileSync(htmlPath, generateHtml(report));

    console.log(`[stress] JSON report: ${jsonPath}`);
    console.log(`[stress] HTML report: ${htmlPath}`);
    return { jsonPath, htmlPath };
  }
}

function generateHtml(report: StressReport): string {
  const data = JSON.stringify(report).replace(/<\/script>/gi, '<\\/script>');
  const scenarioRows = ['totalMessages', 'successRate', 'avgResponseTimeMs', 'p95ResponseTimeMs', 'p99ResponseTimeMs', 'maxResponseTimeMs', 'failureCount', 'timeoutCount']
    .map(k => {
      const s = report.scenarios;
      const fmt = (v: number) => k === 'successRate' ? v.toFixed(1) + '%' : k.includes('Ms') ? v + 'ms' : String(v);
      return '<tr><td>' + k + '</td><td>' + fmt((s.singleSession as any)[k]) + '</td><td>' + fmt((s.multiSession as any)[k]) + '</td><td>' + fmt((s.mixed as any)[k]) + '</td></tr>';
    })
    .join('\n');

  const errorDetails = report.errors.length === 0
    ? '<p>No errors recorded.</p>'
    : report.errors.map((e) => `<details>
  <summary>${e.timestamp} — ${e.error?.type || 'unknown'} — ${e.scenario}/${e.sessionId.slice(0, 8)} #${e.messageIndex}</summary>
  <p><strong>Message:</strong> ${e.error?.message || 'N/A'}</p>
  <p><strong>Response time:</strong> ${e.responseTimeMs}ms</p>
  ${e.error?.screenshot ? '<p><img src="' + e.error.screenshot + '" style="max-width:600px;border:1px solid #ddd;border-radius:4px;" /></p>' : ''}
</details>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Stress Test Report — ${report.meta.startTime}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; padding: 24px; }
  h1 { margin-bottom: 8px; } h2 { margin: 24px 0 12px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; }
  .card { background: #fff; border-radius: 8px; padding: 16px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1); min-width: 160px; }
  .card .value { font-size: 28px; font-weight: 700; } .card .label { font-size: 13px; color: #888; }
  .card.success .value { color: #16a34a; } .card.fail .value { color: #dc2626; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #eee; } th { background: #fafafa; font-weight: 600; }
  canvas { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  details { background: #fff; border-radius: 8px; margin: 8px 0; padding: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  summary { cursor: pointer; font-weight: 600; }
  .charts { display: flex; gap: 24px; flex-wrap: wrap; margin: 16px 0; }
</style>
</head>
<body>
<h1>Chat Stress Test Report</h1>
<p>${report.meta.startTime} — ${report.meta.endTime} (${report.meta.durationMinutes} min)</p>

<h2>Summary</h2>
<div class="cards">
  <div class="card success"><div class="value">${report.summary.successRate.toFixed(1)}%</div><div class="label">Success Rate</div></div>
  <div class="card"><div class="value">${report.summary.totalMessages}</div><div class="label">Total Messages</div></div>
  <div class="card"><div class="value">${report.summary.avgResponseTimeMs}ms</div><div class="label">Avg Response</div></div>
  <div class="card"><div class="value">${report.summary.p95ResponseTimeMs}ms</div><div class="label">P95 Response</div></div>
  <div class="card"><div class="value">${report.summary.p99ResponseTimeMs}ms</div><div class="label">P99 Response</div></div>
  <div class="card fail"><div class="value">${report.summary.failureCount}</div><div class="label">Failures</div></div>
</div>

<h2>Charts</h2>
<div class="charts">
  <canvas id="timelineChart" width="700" height="300"></canvas>
  <canvas id="errorPie" width="300" height="300"></canvas>
</div>

<h2>Scenario Comparison</h2>
<table>
<tr><th>Metric</th><th>Single Session</th><th>Multi Session</th><th>Mixed</th></tr>
${scenarioRows}
</table>

<h2>Errors (${report.errors.length})</h2>
${errorDetails}

<script>
const report = ${data};

(() => {
  const c = document.getElementById('timelineChart');
  const ctx = c.getContext('2d');
  const tl = report.timeline;
  if (tl.length === 0) return;
  const W = c.width, H = c.height, pad = 50;
  const maxY = Math.max(...tl.map(r => r.responseTimeMs), 1);
  const t0 = new Date(tl[0].timestamp).getTime();
  const t1 = new Date(tl[tl.length-1].timestamp).getTime() || t0 + 1;
  ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (H - 2*pad) * (1 - i/4);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W-10, y); ctx.stroke();
    ctx.fillStyle = '#888'; ctx.font = '11px sans-serif';
    ctx.fillText(Math.round(maxY * i/4) + 'ms', 2, y + 4);
  }
  const colors = { single: '#3b82f6', multi: '#f59e0b', mixed: '#8b5cf6' };
  for (const scenario of ['single','multi','mixed']) {
    const pts = tl.filter(r => r.scenario === scenario);
    if (pts.length === 0) continue;
    ctx.strokeStyle = colors[scenario]; ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = pad + (new Date(p.timestamp).getTime() - t0) / (t1 - t0) * (W - pad - 10);
      const y = pad + (H - 2*pad) * (1 - p.responseTimeMs / maxY);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  let lx = pad + 10;
  for (const [name, color] of Object.entries(colors)) {
    ctx.fillStyle = color; ctx.fillRect(lx, 10, 12, 12);
    ctx.fillStyle = '#333'; ctx.font = '12px sans-serif'; ctx.fillText(name, lx + 16, 21);
    lx += 80;
  }
  tl.filter(r => !r.success).forEach(p => {
    const x = pad + (new Date(p.timestamp).getTime() - t0) / (t1 - t0) * (W - pad - 10);
    const y = pad + (H - 2*pad) * (1 - p.responseTimeMs / maxY);
    ctx.fillStyle = '#dc2626'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2); ctx.fill();
  });
})();

(() => {
  const c = document.getElementById('errorPie');
  const ctx = c.getContext('2d');
  const ebt = report.summary.errorsByType;
  const entries = Object.entries(ebt);
  if (entries.length === 0) {
    ctx.fillStyle = '#888'; ctx.font = '14px sans-serif';
    ctx.fillText('No errors', c.width/2 - 30, c.height/2);
    return;
  }
  const total = entries.reduce((s, [,v]) => s + v, 0);
  const pieColors = ['#dc2626','#f59e0b','#3b82f6','#8b5cf6','#10b981'];
  let angle = -Math.PI/2;
  const cx = c.width/2, cy = c.height/2 - 20, r = 100;
  entries.forEach(([name, count], i) => {
    const slice = (count/total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, angle, angle+slice); ctx.closePath();
    ctx.fillStyle = pieColors[i % pieColors.length]; ctx.fill();
    const mid = angle + slice/2;
    const lx = cx + Math.cos(mid) * (r + 20);
    const ly = cy + Math.sin(mid) * (r + 20);
    ctx.fillStyle = '#333'; ctx.font = '11px sans-serif';
    ctx.fillText(name + ' (' + count + ')', lx - 20, ly);
    angle += slice;
  });
})();
</script>
</body>
</html>`;
}

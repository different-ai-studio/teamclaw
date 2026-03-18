import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
} from '../_utils/tauri-mcp-test-utils';
import { verifyStoreExposed, isOpenCodeReady, waitForIdle, archiveSession } from './stress-helpers';
import { loadConfig, computeTimeBudgets } from './stress-config';
import { StressReporter } from './stress-reporter';
import { runSingleSession, runMultiSession, runMixedMode } from './stress-scenarios';

const config = loadConfig();
const budgets = computeTimeBudgets(config);
const reporter = new StressReporter(config);

describe('Chat stress test', () => {
  let ready = false;

  beforeAll(async () => {
    console.log(`[stress] Config: ${JSON.stringify(config, null, 2)}`);

    await launchTeamClawApp();
    await sleep(10_000);
    await focusWindow();
    await sleep(2_000);

    const storeOk = await verifyStoreExposed();
    if (!storeOk) {
      throw new Error('__TEAMCLAW_STORES__ not found on window. Is the app running in dev mode?');
    }

    for (let i = 0; i < 30; i++) {
      if (await isOpenCodeReady()) { ready = true; break; }
      await sleep(2_000);
    }
    if (!ready) {
      throw new Error('OpenCode did not become ready within 60s');
    }

    console.log('[stress] App launched and OpenCode ready. Starting stress test...');
  }, 120_000);

  afterAll(async () => {
    try {
      const { jsonPath, htmlPath } = reporter.writeReports(config.reportDir);
      console.log(`[stress] Reports written:\n  JSON: ${jsonPath}\n  HTML: ${htmlPath}`);
    } catch (err: any) {
      console.error('[stress] Failed to write reports:', err.message);
    }

    try {
      for (const id of reporter.getSessionIds()) {
        try { await archiveSession(id); } catch { /* may already be archived */ }
      }
    } catch { /* best-effort */ }

    await stopApp();
  }, 60_000);

  it('scenario 1: single session continuous', async () => {
    expect(ready).toBe(true);
    await waitForIdle();
    await runSingleSession(budgets.singleSessionMs, config, reporter);
  }, budgets.singleSessionMs + 60_000);

  it('scenario 2: multi session concurrent', async () => {
    expect(ready).toBe(true);
    await waitForIdle();
    await runMultiSession(budgets.multiSessionMs, config, reporter);
  }, budgets.multiSessionMs + 60_000);

  it('scenario 3: mixed mode', async () => {
    expect(ready).toBe(true);
    await waitForIdle();
    await runMixedMode(budgets.mixedModeMs, config, reporter);
  }, budgets.mixedModeMs + 60_000);
});

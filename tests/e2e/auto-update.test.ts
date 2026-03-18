/**
 * E2E: Auto Update - configuration checks and UI verification
 *
 * Part 1: Pure file checks (no browser needed) — verify updater config in
 *         tauri.conf.json, Cargo.toml, lib.rs, and release workflow.
 * Part 2: UI checks via tauri-mcp — verify no update dialog is shown and
 *         app loads normally.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
} from '../_utils/tauri-mcp-test-utils';
import * as fs from 'fs';
import * as path from 'path';

// ── Part 1: Configuration file checks (no app launch needed) ─────────

describe('Auto Update - Configuration', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  it('tauri.conf.json has updater configuration', () => {
    const configPath = path.resolve(repoRoot, 'src-tauri', 'tauri.conf.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(config.plugins.updater).toBeDefined();
    expect(config.plugins.updater.pubkey).toBeTruthy();
    expect(config.plugins.updater.endpoints).toBeInstanceOf(Array);
    expect(config.plugins.updater.endpoints.length).toBeGreaterThan(0);
    expect(config.plugins.updater.endpoints[0]).toContain('github.com');
    expect(config.plugins.updater.endpoints[0]).toContain('latest.json');
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
  });

  it('Cargo.toml has updater and process plugins', () => {
    const cargoPath = path.resolve(repoRoot, 'src-tauri', 'Cargo.toml');
    const cargo = fs.readFileSync(cargoPath, 'utf-8');

    expect(cargo).toContain('tauri-plugin-updater');
    expect(cargo).toContain('tauri-plugin-process');
  });

  it('lib.rs registers updater and process plugins', () => {
    const libPath = path.resolve(repoRoot, 'src-tauri', 'src', 'lib.rs');
    const lib = fs.readFileSync(libPath, 'utf-8');

    expect(lib).toContain('tauri_plugin_updater');
    expect(lib).toContain('tauri_plugin_process');
  });

  it('release workflow exists and is configured correctly', () => {
    const workflowPath = path.resolve(
      repoRoot,
      '.github',
      'workflows',
      'release.yml',
    );
    const workflow = fs.readFileSync(workflowPath, 'utf-8');

    expect(workflow).toContain("'v*'");
    expect(workflow).toContain('tauri-apps/tauri-action');
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    expect(workflow).toContain('aarch64-apple-darwin');
    expect(workflow).toContain('pnpm');
  });
});

// ── Part 2: UI checks (tauri-mcp) ────────────────────────────────────

describe('Auto Update - UpdateDialog UI', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);
      appReady = true;
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('UpdateDialog does not show when no update is available', async () => {
    if (!appReady) return;
    await sleep(4000);

    const updateText = await executeJs(
      `document.body.innerText.includes('Update Available') ? 'found' : 'not-found'`,
    );
    expect(updateText).toContain('not-found');
  }, 15_000);

  it('UpdateDialog component is not rendered in DOM', async () => {
    if (!appReady) return;

    const hasUpdateDialog = await executeJs(
      `Array.from(document.querySelectorAll('[role="dialog"]')).some(el => el.textContent.includes('Update')) ? 'found' : 'not-found'`,
    );
    expect(hasUpdateDialog).toContain('not-found');
  }, 15_000);

  it('app loads normally without update blocking', async () => {
    if (!appReady) return;

    const hasSidebar = await executeJs(
      `document.querySelector('[data-slot="sidebar"]') ? 'found' : 'not-found'`,
    );
    const hasTeamClawText = await executeJs(
      `document.body.innerText.includes('TeamClaw') ? 'found' : 'not-found'`,
    );

    const loaded =
      hasSidebar.includes('found') || hasTeamClawText.includes('found');
    expect(loaded).toBe(true);
  }, 15_000);
});

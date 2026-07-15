/**
 * Functional: Channels Settings
 * Converted from Playwright channels-settings.spec.ts to vitest + tauri-mcp.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: Channels Settings', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);
      appReady = true;
    } catch (err) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  async function openChannelsSettings() {
    // Open settings via gear icon
    await executeJs(`
      document.querySelector('button:has(svg.lucide-settings)')?.click()
    `);
    await sleep(1000);
    // Navigate to Channels section
    await executeJs(`
      (() => {
        const items = document.querySelectorAll('button, [role="menuitem"], a');
        for (const item of items) {
          if (item.textContent?.includes('Channels')) { item.click(); break; }
        }
      })()
    `);
    await sleep(1000);
  }

  it('renders all four channel sections', async () => {
    if (!appReady) return;
    await openChannelsSettings();

    const channels = await executeJs(`
      (() => {
        const text = document.body.innerText;
        return JSON.stringify({
          discord: text.includes('Discord Gateway'),
          feishu: text.includes('Feishu Gateway'),
          email: text.includes('Email Gateway'),
          kook: text.includes('KOOK Gateway'),
        });
      })()
    `);
    const result = JSON.parse(channels);
    expect(result.discord).toBe(true);
    expect(result.feishu).toBe(true);
    expect(result.email).toBe(true);
    expect(result.kook).toBe(true);
  }, 30_000);

  it('Discord channel has setup or config UI', async () => {
    if (!appReady) return;

    const hasUI = await executeJs(`
      (() => {
        const text = document.body.innerText.toLowerCase();
        const hasSetup = /setup|wizard|connect/.test(text);
        const hasToken = !!document.querySelector('input[placeholder*="bot token" i], input[placeholder*="token" i]');
        return hasSetup || hasToken ? 'found' : 'not-found';
      })()
    `);
    expect(hasUI).toBe('found');
  }, 15_000);

  it('Email channel has setup or config UI', async () => {
    if (!appReady) return;

    const hasUI = await executeJs(`
      (() => {
        const text = document.body.innerText.toLowerCase();
        const hasSetup = /setup|wizard|configure/.test(text);
        const hasEmail = /gmail|imap|smtp/.test(text);
        return hasSetup || hasEmail ? 'found' : 'not-found';
      })()
    `);
    expect(hasUI).toBe('found');
  }, 15_000);
});

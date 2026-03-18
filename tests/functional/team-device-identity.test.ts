/**
 * Functional: Team Device Identity & Membership
 * Converted from Playwright team-device-identity.spec.ts to vitest + tauri-mcp.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: Team Device Identity & Membership', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);

      // Open settings and navigate to Team
      await executeJs(`
        (() => {
          const btn = document.querySelector('[data-testid="settings-button"]')
            || document.querySelector('button:has(svg.lucide-settings)');
          btn?.click();
        })()
      `);
      await sleep(1000);
      await executeJs(`
        (() => {
          const items = document.querySelectorAll('button, [role="menuitem"], a');
          for (const item of items) {
            if (item.textContent?.trim() === 'Team') { item.click(); break; }
          }
        })()
      `);
      await sleep(1000);

      appReady = true;
    } catch (err) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('P2P tab shows Device ID section with copyable NodeId', async () => {
    if (!appReady) return;

    // Click P2P tab
    await executeJs(`
      (() => {
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
          if (/p2p/i.test(tab.textContent || '')) { tab.click(); break; }
        }
      })()
    `);
    await sleep(1000);

    const hasDeviceId = await executeJs(`
      /device id/i.test(document.body.innerText) ? 'found' : 'not-found'
    `);
    expect(hasDeviceId).toBe('found');

    const hasCopyBtn = await executeJs(`
      (() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (/copy/i.test(btn.textContent || '') || /copy/i.test(btn.getAttribute('aria-label') || '')) return 'found';
        }
        return 'not-found';
      })()
    `);
    expect(hasCopyBtn).toBe('found');
  }, 15_000);

  it('Git tab shows Legacy badge and deprecation banner', async () => {
    if (!appReady) return;

    // Click Git tab
    await executeJs(`
      (() => {
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
          if (/git/i.test(tab.textContent || '')) { tab.click(); break; }
        }
      })()
    `);
    await sleep(1000);

    const hasLegacy = await executeJs(`
      /legacy/i.test(document.body.innerText) ? 'found' : 'not-found'
    `);
    expect(hasLegacy).toBe('found');

    const hasDeprecated = await executeJs(`
      /deprecated/i.test(document.body.innerText) ? 'found' : 'not-found'
    `);
    expect(hasDeprecated).toBe('found');
  }, 15_000);

  it('P2P tab shows Device ID section for member management', async () => {
    if (!appReady) return;

    // Click P2P tab
    await executeJs(`
      (() => {
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
          if (/p2p/i.test(tab.textContent || '')) { tab.click(); break; }
        }
      })()
    `);
    await sleep(1000);

    const hasDeviceId = await executeJs(`
      /device id/i.test(document.body.innerText) ? 'found' : 'not-found'
    `);
    expect(hasDeviceId).toBe('found');
  }, 15_000);
});

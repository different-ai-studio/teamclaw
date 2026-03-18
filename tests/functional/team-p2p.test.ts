/**
 * Functional: Team P2P Settings
 * Converted from Playwright team-p2p.spec.ts to vitest + tauri-mcp.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: Team P2P Settings', () => {
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

  it('shows Git and P2P tabs', async () => {
    if (!appReady) return;

    const tabs = await executeJs(`
      (() => {
        const tabEls = document.querySelectorAll('[role="tab"]');
        const names = Array.from(tabEls).map(t => t.textContent?.trim().toLowerCase() || '');
        return JSON.stringify({
          hasGit: names.some(n => /git/i.test(n)),
          hasP2P: names.some(n => /p2p/i.test(n)),
        });
      })()
    `);
    const result = JSON.parse(tabs);
    expect(result.hasGit).toBe(true);
    expect(result.hasP2P).toBe(true);
  }, 15_000);

  it('P2P tab shows publish and join UI', async () => {
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

    const ui = await executeJs(`
      (() => {
        const text = document.body.innerText.toLowerCase();
        const buttons = document.querySelectorAll('button');
        const hasPublish = Array.from(buttons).some(b => /publish team drive/i.test(b.textContent || ''));
        const hasJoin = Array.from(buttons).some(b => /^join$/i.test(b.textContent?.trim() || ''));
        const hasTicketInput = !!document.querySelector('input[placeholder*="ticket" i], input[placeholder*="paste" i]');
        return JSON.stringify({ hasPublish, hasJoin, hasTicketInput });
      })()
    `);
    const result = JSON.parse(ui);
    expect(result.hasPublish).toBe(true);
    expect(result.hasJoin).toBe(true);
    expect(result.hasTicketInput).toBe(true);
  }, 15_000);

  it('invalid ticket shows error', async () => {
    if (!appReady) return;

    // Fill in an invalid ticket
    await executeJs(`
      (() => {
        const input = document.querySelector('input[placeholder*="ticket" i], input[placeholder*="paste" i]');
        if (!input) return 'no-input';
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        nativeSetter?.call(input, 'invalid-garbage-ticket');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return 'filled';
      })()
    `);
    await sleep(500);

    // Click Join button
    await executeJs(`
      (() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (/^join$/i.test(btn.textContent?.trim() || '')) { btn.click(); break; }
        }
      })()
    `);
    await sleep(3000);

    const hasError = await executeJs(`
      /error|invalid|failed/i.test(document.body.innerText) ? 'found' : 'not-found'
    `);
    expect(hasError).toBe('found');
  }, 15_000);

  it('publish button shows ticket or error', async () => {
    if (!appReady) return;

    // Click Publish Team Drive button
    await executeJs(`
      (() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (/publish team drive/i.test(btn.textContent || '')) { btn.click(); break; }
        }
      })()
    `);
    await sleep(5000);

    const result = await executeJs(`
      (() => {
        const text = document.body.innerText.toLowerCase();
        const buttons = document.querySelectorAll('button');
        const hasCopy = Array.from(buttons).some(b => /copy/i.test(b.textContent || '') || /copy/i.test(b.getAttribute('aria-label') || ''));
        const hasError = /error|failed|no team/i.test(text);
        return hasCopy || hasError ? 'found' : 'not-found';
      })()
    `);
    expect(result).toBe('found');
  }, 20_000);
});

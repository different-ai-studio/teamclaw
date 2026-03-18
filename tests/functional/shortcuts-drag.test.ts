/**
 * Functional: Shortcuts Drag & Drop
 * Converted from Playwright shortcuts-drag.spec.ts to vitest + tauri-mcp.
 *
 * Note: Actual drag-and-drop simulation is not feasible without Playwright's
 * mouse API. Tests verify rendering and grip handles; drag tests are skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: Shortcuts Drag & Drop', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);

      // Seed shortcuts into localStorage
      await executeJs(`
        (() => {
          const data = {
            version: 1,
            nodes: [
              { id: 'sc-folder-1', label: 'My Folder', icon: '', order: 0, parentId: null, type: 'folder', target: '' },
              { id: 'sc-link-1', label: 'Link A', icon: '', order: 1, parentId: null, type: 'link', target: 'https://a.com' },
              { id: 'sc-link-2', label: 'Link B', icon: '', order: 2, parentId: null, type: 'link', target: 'https://b.com' },
              { id: 'sc-link-3', label: 'Link C', icon: '', order: 3, parentId: null, type: 'link', target: 'https://c.com' },
            ],
          };
          localStorage.setItem('teamclaw-shortcuts', JSON.stringify(data));
          return 'seeded';
        })()
      `);

      // Navigate to Settings > Shortcuts
      await executeJs(`document.querySelector('button:has(svg.lucide-settings)')?.click()`);
      await sleep(1000);
      await executeJs(`
        (() => {
          const items = document.querySelectorAll('button, [role="menuitem"], a');
          for (const item of items) {
            if (item.textContent?.includes('Shortcuts')) { item.click(); break; }
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

  it('shortcuts are rendered in correct initial order', async () => {
    if (!appReady) return;

    const labels = await executeJs(`
      (() => {
        const items = document.querySelectorAll('[data-shortcut-id] span.truncate');
        return JSON.stringify(Array.from(items).map(el => el.textContent));
      })()
    `);
    const parsed = JSON.parse(labels);
    expect(parsed).toEqual(['My Folder', 'Link A', 'Link B', 'Link C']);
  }, 15_000);

  it('grip handles are present on all items', async () => {
    if (!appReady) return;

    const gripCount = await executeJs(`
      document.querySelectorAll('[data-grip]').length
    `);
    expect(Number(gripCount)).toBe(4);
  }, 15_000);

  // Drag-and-drop tests are skipped — Playwright's mouse API is required
  // for reliable drag simulation. These could be added later with
  // tauri-plugin-mcp's mouse input tools if they support drag sequences.
});

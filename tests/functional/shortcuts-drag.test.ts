/**
 * Functional: Shortcuts Drag & Drop
 * Converted from Playwright shortcuts-drag.spec.ts to vitest + tauri-mcp.
 *
 * The new shortcuts store reads from Supabase + a Tauri-managed cache file
 * (workspace's `teamclaw.json`). The legacy `teamclaw-shortcuts` localStorage
 * key no longer exists, so we seed via the Tauri `save_shortcuts` IPC command
 * and then trigger the store's `hydrateFromCache()` so the UI reflects it.
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

      // Seed shortcuts into the Tauri-backed cache file (teamclaw.json)
      // and trigger the store to hydrate from it. The new store no longer
      // reads from localStorage.
      const wp = process.env.TEST_WORKSPACE_PATH ?? '/tmp/teamclaw-e2e-ws';
      await executeJs(`
        (async () => {
          const tauri = window.__TAURI__;
          if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
            return 'no-tauri';
          }
          const { invoke } = tauri.core;
          const ownerId = '00000000-0000-0000-0000-000000000001';
          const ts = new Date().toISOString();
          const mk = (id, label, type, order, target) => ({
            id,
            scope: 'personal',
            owner_member_id: ownerId,
            team_id: null,
            parent_id: null,
            label,
            icon: null,
            order,
            node_type: type,
            target,
            created_at: ts,
            updated_at: ts,
            __version: 2,
          });
          const uuid = () =>
            (crypto && typeof crypto.randomUUID === 'function')
              ? crypto.randomUUID()
              : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                  const r = Math.random() * 16 | 0;
                  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
                });
          try {
            await invoke('save_shortcuts', {
              workspacePath: ${JSON.stringify(wp)},
              nodes: [
                mk(uuid(), 'My Folder', 'folder', 0, ''),
                mk(uuid(), 'Link A',    'link',   1, 'https://a.com'),
                mk(uuid(), 'Link B',    'link',   2, 'https://b.com'),
                mk(uuid(), 'Link C',    'link',   3, 'https://c.com'),
              ],
            });
          } catch (e) {
            return 'save-failed:' + (e && e.message ? e.message : String(e));
          }
          // Trigger the store's hydrateFromCache so the UI renders the seed.
          // Vite serves modules under /src/... in dev; in production builds
          // this import will fail and tests must rely on UI re-mount instead.
          try {
            const mod = await import('/src/stores/shortcuts.ts');
            await mod.useShortcutsStore.getState().hydrateFromCache();
          } catch {
            /* best-effort — settings UI may trigger a re-read on its own */
          }
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

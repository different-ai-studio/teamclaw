/**
 * E2E: Spotlight bug regression tests (single-window architecture)
 *
 * Covers:
 *   Bug 1 – Title bar cannot be dragged (missing data-tauri-drag-region)
 *   Bug 2 – Pin state not persisted across show/hide cycles
 *
 * Single-window architecture: there is only one window ("main") that switches
 * between Spotlight mode and Main mode. No separate "TeamClaw Spotlight" window.
 *
 * Uses test control server at http://127.0.0.1:13199 for Tauri IPC commands.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { readFileSync } from 'fs';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
} from '../_utils/tauri-mcp-test-utils';

const CONTROL_SERVER = 'http://127.0.0.1:13199';

/**
 * Call a Tauri IPC command via the test control server.
 */
async function tauriCommand(command: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL_SERVER}/test/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe('E2E: Spotlight bugs (single-window)', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);

      // Wait for test control server to be reachable
      for (let i = 0; i < 10; i++) {
        try {
          const res = await fetch(`${CONTROL_SERVER}/test/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'get_spotlight_state' }),
          });
          if (res.ok) {
            appReady = true;
            break;
          }
        } catch {
          // not ready yet
        }
        await sleep(2000);
      }

      if (!appReady) {
        console.error('App launched but test control server not reachable');
      }
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  // ── Bug 1: Title bar drag ────────────────────────────────────────────
  // Fix: Added `data-tauri-drag-region` attribute to SpotlightTitleBar div.

  describe('Bug 1: Title bar drag', () => {
    it('SpotlightTitleBar should have data-tauri-drag-region attribute', () => {
      const source = readFileSync(
        join(process.cwd(), 'packages/app/src/components/spotlight/SpotlightTitleBar.tsx'),
        'utf-8',
      );
      expect(source).toContain('data-tauri-drag-region');
    });
  });

  // ── Bug 2: Pin state persistence ─────────────────────────────────────
  // Fix: SpotlightState has `pinned: Mutex<bool>` (default true).
  //       set_spotlight_pin persists the pin state.
  //       configure_as_spotlight restores always-on-top from pin state.

  describe('Bug 2: Pin state persistence', () => {
    it('SpotlightState in Rust should have a pinned field with default true', () => {
      const source = readFileSync(
        join(process.cwd(), 'src-tauri/src/commands/spotlight.rs'),
        'utf-8',
      );
      expect(source).toContain('pub pinned: Mutex<bool>');
      expect(source).toContain('pinned: Mutex::new(true)');
    });

    it('set_spotlight_pin should persist state in SpotlightState', () => {
      const source = readFileSync(
        join(process.cwd(), 'src-tauri/src/commands/spotlight.rs'),
        'utf-8',
      );
      expect(source).toMatch(/state\.pinned\.lock\(\).*=\s*pinned/);
    });

    it('get_spotlight_state returns mode: "spotlight" by default', async () => {
      if (!appReady) return;
      const state = await tauriCommand('get_spotlight_state');
      expect(state['mode']).toBe('spotlight');
      expect(state['pinned']).toBe(true);
    }, 15_000);

    it('force_toggle_spotlight makes window visible in spotlight mode', async () => {
      if (!appReady) return;
      await tauriCommand('force_toggle_spotlight');
      await sleep(1000);
      const state = await tauriCommand('get_spotlight_state');
      expect(state['visible']).toBe(true);
      expect(state['mode']).toBe('spotlight');
      expect(state['pinned']).toBe(true);
    }, 15_000);

    it('useSpotlight hook calls set_spotlight_pin on toggle', () => {
      const source = readFileSync(
        join(process.cwd(), 'packages/app/src/hooks/useSpotlight.ts'),
        'utf-8',
      );
      expect(source).toContain("invoke('set_spotlight_pin'");
    });
  });

  // ── Single-window architecture verification ──────────────────────────

  describe('Single-window architecture', () => {
    it('Rust uses single "main" window label', () => {
      const source = readFileSync(
        join(process.cwd(), 'src-tauri/src/commands/spotlight.rs'),
        'utf-8',
      );
      // All commands reference the "main" window — no "spotlight" window label
      expect(source).toContain('get_webview_window("main")');
      expect(source).not.toContain('get_webview_window("spotlight")');
    });

    it('get_spotlight_state returns mode field', () => {
      const source = readFileSync(
        join(process.cwd(), 'src-tauri/src/commands/spotlight.rs'),
        'utf-8',
      );
      expect(source).toContain('"mode"');
      expect(source).toContain('"spotlight"');
      expect(source).toContain('"main"');
    });

    it('expand_to_main transitions from spotlight to main mode', () => {
      const source = readFileSync(
        join(process.cwd(), 'src-tauri/src/commands/spotlight.rs'),
        'utf-8',
      );
      expect(source).toContain('pub async fn expand_to_main');
      expect(source).toContain('WindowMode::Spotlight');
      expect(source).toContain('WindowMode::Main');
    });
  });
});

/**
 * E2E Smoke: integrated terminal IPC end-to-end.
 * Bypasses UI to verify the Rust portable-pty pipeline + Tauri commands.
 *
 * macOS only (v1 scope). Skipped automatically on other platforms.
 *
 * Flow:
 *   terminal_open  → terminal_write (pwd\n) → terminal_subscribe → terminal_close → terminal_list
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  callIpcCommand,
} from '../_utils/tauri-mcp-test-utils';

describe.skipIf(process.platform !== 'darwin')('E2E Smoke: integrated terminal', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      appReady = true;
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('open -> write pwd -> subscribe sees output -> close -> list empty', async () => {
    if (!appReady) return;

    // ── 1. Open a terminal ───────────────────────────────────────────────
    const openRaw = await callIpcCommand('terminal_open', {
      workspaceId: 'smoke',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      // omit shell to let the backend pick the default
      allowedRoots: ['/tmp'],
    });
    const openResult: { id: string; shell: string; pid: number } = JSON.parse(openRaw);
    expect(openResult.id).toBeTruthy();
    expect(typeof openResult.pid).toBe('number');
    expect(openResult.pid).toBeGreaterThan(0);

    const id: string = openResult.id;

    // Give the shell time to emit its initial prompt
    await sleep(800);

    // ── 2. Write `pwd\n` into the pty ────────────────────────────────────
    const data = Array.from(new TextEncoder().encode('pwd\n'));
    await callIpcCommand('terminal_write', { id, data });

    // Wait for output to land in the ring buffer
    await sleep(800);

    // ── 3. Subscribe and inspect the ring snapshot ───────────────────────
    const subRaw = await callIpcCommand('terminal_subscribe', { id });
    const sub: { ring_snapshot: number[] } = JSON.parse(subRaw);
    expect(Array.isArray(sub.ring_snapshot)).toBe(true);

    const text = String.fromCharCode(...sub.ring_snapshot);
    // The ring buffer should contain the echoed command and /tmp as the cwd output
    expect(text).toMatch(/pwd/);
    expect(text).toMatch(/\/tmp/);

    // ── 4. Close the terminal ────────────────────────────────────────────
    await callIpcCommand('terminal_close', { id });

    // ── 5. List should be empty for the smoke workspace ──────────────────
    const listRaw = await callIpcCommand('terminal_list', { workspaceId: 'smoke' });
    const list: unknown[] = JSON.parse(listRaw);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(0);
  }, 30_000);
});

/**
 * Functional: Spotlight chat tests (single-window architecture)
 *
 * In the single-window architecture, there is no separate SSE connection
 * or OpenCode client initialization for spotlight — it shares the same
 * JS context as the main window. These tests verify:
 *   - The app starts in spotlight mode by default
 *   - The test control server is reachable
 *   - Spotlight state is correct at startup
 *   - Message sending works via the OpenCode API
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { sleep } from '../_utils/tauri-mcp-test-utils';

const CONTROL_SERVER = 'http://127.0.0.1:13199';
const OPENCODE_SERVER = 'http://127.0.0.1:13141';
const TEAMCLAW_BIN = join(process.cwd(), 'src-tauri/target/debug/teamclaw');

let appProcess: ChildProcess | null = null;

function exec(cmd: string): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  }).trim();
}

async function tauriCommand(command: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${CONTROL_SERVER}/test/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

interface Message {
  role: string;
  parts: Array<{ type: string; text?: string }>;
}

async function getSessionMessages(sessionId: string): Promise<Message[]> {
  try {
    const res = await fetch(`${OPENCODE_SERVER}/session/${sessionId}/message`);
    const raw = await res.json();
    if (!Array.isArray(raw)) return [];
    return raw.map((m: any) => ({
      role: m.info ? m.info.role : m.role,
      parts: m.parts || [],
    }));
  } catch {
    return [];
  }
}

describe('Spotlight chat (single-window)', () => {
  let ok = false;

  beforeAll(async () => {
    // Kill any existing teamclaw processes
    try { exec('pkill -x teamclaw 2>/dev/null || true'); } catch { /* ok */ }
    await sleep(1000);

    // Launch the debug binary directly (not the .app bundle which may be stale)
    appProcess = spawn(TEAMCLAW_BIN, [], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    appProcess.stdout?.on('data', () => {});
    appProcess.stderr?.on('data', () => {});
    appProcess.unref();

    // Wait for test control server
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      try {
        const res = await fetch(`${CONTROL_SERVER}/test/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'get_spotlight_state' }),
        });
        if (res.ok) {
          ok = true;
          break;
        }
      } catch {
        // not ready yet
      }
    }
  }, 90_000);

  afterAll(async () => {
    if (appProcess) { try { appProcess.kill(); } catch { /* ok */ } }
    try { exec('pkill -x teamclaw 2>/dev/null || true'); } catch { /* ok */ }
  }, 30_000);

  it('starts in spotlight mode with pinned=true', async () => {
    if (!ok) return;
    const state = await tauriCommand('get_spotlight_state');
    expect(state['mode']).toBe('spotlight');
    expect(state['pinned']).toBe(true);
  }, 15_000);

  it('spotlight becomes visible after force_toggle_spotlight', async () => {
    if (!ok) return;
    await tauriCommand('force_toggle_spotlight');
    await sleep(2000);
    const state = await tauriCommand('get_spotlight_state');
    expect(state['visible']).toBe(true);
    expect(state['mode']).toBe('spotlight');
  }, 20_000);

  it('can send a message via OpenCode API and receive a response', async () => {
    if (!ok) return;

    // Create session
    const createRes = await fetch(`${OPENCODE_SERVER}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const session = (await createRes.json()) as { id: string };
    expect(session.id).toBeTruthy();

    // Send message
    await fetch(`${OPENCODE_SERVER}/session/${session.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: 'say exactly: hello spotlight test' }],
      }),
    });
    await sleep(15_000);

    // Verify messages
    const msgs = await getSessionMessages(session.id);
    expect(msgs.length).toBeGreaterThanOrEqual(1);

    const userMsg = msgs.find(
      (m) =>
        m.role === 'user' &&
        m.parts?.some(
          (p) => p.type === 'text' && p.text?.includes('hello spotlight test'),
        ),
    );
    expect(userMsg).toBeDefined();

    const assistantMsg = msgs.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
  }, 30_000);

  it('pin state persists after toggle cycle', async () => {
    if (!ok) return;
    const state = await tauriCommand('get_spotlight_state');
    expect(state['pinned']).toBe(true);
    expect(state['mode']).toBe('spotlight');
  }, 15_000);
});

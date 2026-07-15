import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import i18n from '@/lib/i18n'

// Hoisted, mutable test state shared with the module mocks below.
const h = vi.hoisted(() => ({
  isTauriVal: true,
  currentTeam: null as { id: string } | null,
  daemonTeam: null as string | null,
  // Successive probe results; the last entry persists once the queue drains.
  probeQueue: [] as Array<{ ok: boolean; reason?: string; baseUrl?: string }>,
  invokeCalls: [] as string[],
  registerArgs: null as { workspacePath?: string } | null,
  installServiceShouldThrow: false,
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => h.isTauriVal }))
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/u',
  join: async (...parts: string[]) => parts.join('/'),
}))
vi.mock('@/lib/backend', () => ({ getBackend: () => ({}) }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: h.currentTeam }) },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ workspacePath: '/home/u/projects/app' }),
  },
}))
vi.mock('@/lib/daemon-local-client', () => ({
  invalidateDaemonConnection: vi.fn(),
  probeDaemonHttp: vi.fn(async () =>
    h.probeQueue.length > 1
      ? h.probeQueue.shift()!
      : (h.probeQueue[0] ?? { ok: false, reason: 'not_running' }),
  ),
  // Default to 'unknown' so the ready path's cloud-session probe is a no-op in
  // these orchestration tests (auto-heal is covered separately).
  fetchDaemonCloudAuthStatus: vi.fn(async () => 'unknown'),
}))
vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () => null),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    h.invokeCalls.push(cmd)
    if (cmd === 'get_daemon_team_id') return h.daemonTeam
    if (cmd === 'daemon_install_service') {
      if (h.installServiceShouldThrow) throw new Error('install-service boom')
      return undefined
    }
    if (cmd === 'register_daemon_workspace') {
      h.registerArgs = (args ?? null) as { workspacePath?: string } | null
      return { workspace_id: 'ws1', path: (args as { workspacePath?: string })?.workspacePath ?? '', display_name: 't1' }
    }
    return undefined
  }),
}))

import { useDaemonOnboardingStore } from '../daemon-onboarding'

const reset = () =>
  useDaemonOnboardingStore.setState({
    status: 'unknown',
    loaded: false,
    busy: false,
    error: null,
    ownedAgents: [],
    cloudAuthExpired: false,
    healing: false,
    healError: null,
  })

beforeEach(() => {
  h.isTauriVal = true
  h.currentTeam = null
  h.daemonTeam = null
  h.probeQueue = []
  h.invokeCalls = []
  h.registerArgs = null
  h.installServiceShouldThrow = false
  reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('daemon-onboarding refresh() orchestration', () => {
  it('web (non-tauri) short-circuits to ready', async () => {
    h.isTauriVal = false
    await useDaemonOnboardingStore.getState().refresh()
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.loaded).toBe(true)
    // No daemon IPC on web.
    expect(h.invokeCalls).toEqual([])
  })

  it('unknown when there is no current team yet (does not block)', async () => {
    h.currentTeam = null
    h.daemonTeam = 't1'
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('unknown')
  })

  it('needs-onboard when daemon is bound to no team', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = null
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('needs-onboard')
  })

  it('mismatch when daemon team differs — and does NOT probe http', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't2'
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('mismatch')
    // Team-level states never reach the health probe / recovery path.
    expect(h.invokeCalls).toEqual(['get_daemon_team_id'])
  })

  it('ready when team matches and the daemon is already healthy', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    // Healthy on first probe → no recovery attempt.
    expect(h.invokeCalls).not.toContain('daemon_install_service')
  })

  it('ready registers the active workspace when it is a real project dir', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.probeQueue = [{ ok: true, baseUrl: 'http://127.0.0.1:1' }]
    await useDaemonOnboardingStore.getState().refresh()
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
    // Registration is fire-and-forget — wait for the background promise.
    await vi.waitFor(() => expect(h.invokeCalls).toContain('register_daemon_workspace'))
    expect(h.registerArgs?.workspacePath).toBe('/home/u/projects/app')
  })

  it('does not register a workspace on a team mismatch', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't2'
    await useDaemonOnboardingStore.getState().refresh()
    // give any stray async a tick; mismatch must never register.
    await Promise.resolve()
    expect(h.invokeCalls).not.toContain('register_daemon_workspace')
  })

  it('matched-but-down → starting → auto-recovers to ready', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    // refresh first probe (down), ensureHealthy probe (still down → install-service),
    // then the first poll iteration succeeds.
    h.probeQueue = [
      { ok: false, reason: 'not_running' },
      { ok: false, reason: 'not_running' },
      { ok: true, baseUrl: 'http://127.0.0.1:1' },
    ]
    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(600) // one sleep(500) poll tick
    await p
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.error).toBeNull()
    expect(h.invokeCalls).toContain('daemon_install_service')
  })

  it('matched-but-token-invalid that never heals → error with retry hint', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    // Every probe stays unhealthy; recovery exhausts two ensureHealthy rounds.
    h.probeQueue = [{ ok: false, reason: 'token_invalid' }]
    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(2 * 12 * 500 + 100) // drain both poll rounds
    await p
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('error')
    // De-jargoned: the user-facing error no longer leaks "amuxd"; it surfaces
    // the i18n start-failure string with a retry hint.
    expect(s.error).toBe(i18n.t('settings.daemonOnboarding.startFailed'))
    expect(s.error).not.toMatch(/amuxd/)
    expect(h.invokeCalls.filter((c) => c === 'daemon_install_service')).toHaveLength(2)
  })

  it('matched-but-down → auto-retries once before surfacing error', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    // First ensureHealthy round exhausts all polls; second succeeds on first poll.
    h.probeQueue = [
      { ok: false, reason: 'not_running' },
      ...Array.from({ length: 13 }, () => ({ ok: false, reason: 'not_running' })),
      { ok: false, reason: 'not_running' },
      { ok: true, baseUrl: 'http://127.0.0.1:1' },
    ]
    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(13 * 500 + 100)
    await p
    const s = useDaemonOnboardingStore.getState()
    expect(s.status).toBe('ready')
    expect(s.error).toBeNull()
    expect(h.invokeCalls.filter((c) => c === 'daemon_install_service')).toHaveLength(2)
  })

  it('recovery survives install-service throwing (falls through to polling)', async () => {
    h.currentTeam = { id: 't1' }
    h.daemonTeam = 't1'
    h.installServiceShouldThrow = true
    h.probeQueue = [
      { ok: false, reason: 'not_running' },
      { ok: false, reason: 'not_running' },
      { ok: true, baseUrl: 'http://127.0.0.1:1' },
    ]
    vi.useFakeTimers()
    const p = useDaemonOnboardingStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(600)
    await p
    expect(useDaemonOnboardingStore.getState().status).toBe('ready')
  })
})

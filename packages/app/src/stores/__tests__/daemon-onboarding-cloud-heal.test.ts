import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted, mutable test state shared with the module mocks below.
const h = vi.hoisted(() => ({
  isTauriVal: true,
  currentTeam: { id: 't1' } as { id: string } | null,
  cloudAuthStatus: 'ok' as 'ok' | 'expired' | 'unknown',
  localActorId: 'actor-1' as string | null,
  // Connected agents returned by listConnectedAgents (loadOwnedAgents filters is_owner).
  connectedAgents: [] as Array<{ agent_id: string; display_name: string; is_owner: boolean; visibility?: string }>,
  invokeCalls: [] as string[],
  createInviteCalls: [] as Array<Record<string, unknown>>,
  installServiceShouldThrow: false,
  restartManagedShouldThrow: false,
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => h.isTauriVal }))
vi.mock('@/lib/startup-perf', () => ({ markStartup: vi.fn() }))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: h.currentTeam }) },
}))
vi.mock('@/stores/member-preferences-store', () => ({
  useMemberPreferencesStore: {
    getState: () => ({
      ensureLoaded: vi.fn(async () => {}),
      defaultAgentId: 'someone',
      setDefaultAgent: vi.fn(async () => {}),
    }),
  },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: '/home/u/.amuxd/teams/t1' }) },
}))
vi.mock('@/lib/daemon-local-client', () => ({
  invalidateDaemonConnection: vi.fn(),
  probeDaemonHttp: vi.fn(async () => ({ ok: true, baseUrl: 'http://127.0.0.1:1' })),
  fetchDaemonCloudAuthStatus: vi.fn(async () => h.cloudAuthStatus),
}))
vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () => h.localActorId),
}))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    teams: {
      createTeamInvite: vi.fn(async (input: Record<string, unknown>) => {
        h.createInviteCalls.push(input)
        return { token: 'tok-123' }
      }),
    },
    actors: {
      listConnectedAgents: vi.fn(async () => h.connectedAgents),
    },
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    h.invokeCalls.push(cmd)
    if (cmd === 'get_daemon_team_id') return 't1'
    if (cmd === 'daemon_init') {
      // Re-onboard rewrites credentials; managed restart reloads backend.toml.
      h.cloudAuthStatus = 'ok'
      return { actorId: 'actor-1', teamId: 't1' }
    }
    if (cmd === 'daemon_restart_managed' && h.restartManagedShouldThrow) {
      throw new Error('managed amuxd restart failed')
    }
    if (cmd === 'daemon_ensure_running' && h.restartManagedShouldThrow) {
      throw new Error('managed amuxd ensure failed')
    }
    if (cmd === 'daemon_install_service' && h.installServiceShouldThrow) {
      throw new Error('amuxd binary not found at ~/.amuxd/bin/amuxd')
    }
    return undefined
  }),
}))

import { useDaemonOnboardingStore } from '../daemon-onboarding'

const reset = () =>
  useDaemonOnboardingStore.setState({
    status: 'ready',
    loaded: true,
    busy: false,
    error: null,
    ownedAgents: [],
    cloudAuthExpired: false,
    healing: false,
    healError: null,
  })

beforeEach(() => {
  h.isTauriVal = true
  h.currentTeam = { id: 't1' }
  h.cloudAuthStatus = 'ok'
  h.localActorId = 'actor-1'
  h.connectedAgents = []
  h.invokeCalls = []
  h.createInviteCalls = []
  h.installServiceShouldThrow = false
  h.restartManagedShouldThrow = false
  reset()
})

describe('daemon-onboarding checkCloudSession + autoHealCloudSession', () => {
  it('healthy session: no banner, no re-onboard', async () => {
    h.cloudAuthStatus = 'ok'
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    expect(s.cloudAuthExpired).toBe(false)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('unknown (older daemon / transient) is treated as healthy', async () => {
    h.cloudAuthStatus = 'unknown'
    await useDaemonOnboardingStore.getState().checkCloudSession()
    expect(useDaemonOnboardingStore.getState().cloudAuthExpired).toBe(false)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('expired + owner: auto re-onboards the SAME actor and clears the flag', async () => {
    h.cloudAuthStatus = 'expired'
    h.localActorId = 'actor-1'
    h.connectedAgents = [{ agent_id: 'actor-1', display_name: 'Build Bot', is_owner: true }]
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    // Re-invite targets the existing actor (rebind, no orphan).
    expect(h.createInviteCalls).toHaveLength(1)
    expect(h.createInviteCalls[0]).toMatchObject({ targetActorId: 'actor-1', kind: 'agent' })
    // amuxd init + managed restart (reload backend.toml).
    expect(h.invokeCalls).toContain('daemon_init')
    expect(h.invokeCalls).toContain('daemon_restart_managed')
    expect(s.cloudAuthExpired).toBe(false)
    expect(s.healError).toBeNull()
  })

  it('onboard fails when managed restart and ensure both fail', async () => {
    // Credentials may be on disk, but the running daemon may still hold the
    // old identity — treat restart/ensure failure as heal failure.
    h.cloudAuthStatus = 'expired'
    h.localActorId = 'actor-1'
    h.connectedAgents = [{ agent_id: 'actor-1', display_name: 'Build Bot', is_owner: true }]
    h.restartManagedShouldThrow = true
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    expect(h.invokeCalls).toContain('daemon_init')
    expect(h.invokeCalls).toContain('daemon_restart_managed')
    expect(h.invokeCalls).toContain('daemon_ensure_running')
    expect(s.healError).toBeTruthy()
  })

  it('expired + NOT owner: flags banner, no re-onboard, surfaces guidance', async () => {
    h.cloudAuthStatus = 'expired'
    h.localActorId = 'actor-1'
    // Owned list does not include the daemon's actor → caller is not the owner.
    h.connectedAgents = [{ agent_id: 'other', display_name: 'x', is_owner: true }]
    await useDaemonOnboardingStore.getState().checkCloudSession()
    const s = useDaemonOnboardingStore.getState()
    expect(s.cloudAuthExpired).toBe(true)
    expect(s.healError).toBeTruthy()
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('does not auto-retry once a heal has failed (healError latched)', async () => {
    h.cloudAuthStatus = 'expired'
    h.connectedAgents = [{ agent_id: 'other', display_name: 'x', is_owner: true }]
    await useDaemonOnboardingStore.getState().checkCloudSession()
    expect(useDaemonOnboardingStore.getState().healError).toBeTruthy()
    h.createInviteCalls = []
    h.invokeCalls = []
    // A second probe must NOT kick off another automatic attempt.
    await useDaemonOnboardingStore.getState().checkCloudSession()
    expect(h.createInviteCalls).toHaveLength(0)
    expect(h.invokeCalls).not.toContain('daemon_init')
  })
})

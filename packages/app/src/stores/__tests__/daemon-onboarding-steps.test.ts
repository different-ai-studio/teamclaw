import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirrors the harness in daemon-onboarding-refresh.test.ts, trimmed to what the
// step model needs.
const h = vi.hoisted(() => ({
  currentTeam: { id: 'team-1' } as { id: string } | null,
  daemonTeam: null as string | null,
  probeOk: true,
  inviteShouldThrow: false,
  initShouldThrow: false,
  registerShouldThrow: false,
  invokeCalls: [] as string[],
}))

vi.mock('@/lib/utils', () => ({ isTauri: () => true }))
vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    teams: {
      createTeamInvite: vi.fn(async () => {
        if (h.inviteShouldThrow) throw new Error('mint boom')
        return { token: 'invite-token' }
      }),
    },
    actors: {
      listConnectedAgents: vi.fn(async () => []),
      makeAgentPersonal: vi.fn(async () => {}),
    },
  }),
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: { getState: () => ({ team: h.currentTeam }) },
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ session: { user: { id: 'user-1' } } }) },
}))
vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: '/home/u/app' }) },
}))
vi.mock('@/stores/member-preferences-store', () => ({
  useMemberPreferencesStore: {
    getState: () => ({
      ensureLoaded: async () => {},
      defaultAgentId: 'already-set',
      setDefaultAgent: async () => {},
    }),
  },
}))
vi.mock('@/lib/daemon-local-client', () => ({
  invalidateDaemonConnection: vi.fn(),
  probeDaemonHttp: vi.fn(async () => ({ ok: h.probeOk, reason: 'not_running' })),
  fetchDaemonCloudAuthStatus: vi.fn(async () => 'ok'),
}))
vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonActorId: vi.fn(async () => 'actor-1'),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    h.invokeCalls.push(cmd)
    if (cmd === 'get_daemon_team_id') return h.daemonTeam
    if (cmd === 'daemon_init') {
      if (h.initShouldThrow) throw new Error('init boom')
      h.daemonTeam = h.currentTeam?.id ?? null
      return { actorId: 'actor-1', teamId: h.daemonTeam }
    }
    if (cmd === 'register_daemon_workspace' && h.registerShouldThrow) {
      throw new Error('register boom')
    }
    return undefined
  }),
}))

import { useDaemonOnboardingStore } from '../daemon-onboarding'

beforeEach(() => {
  h.currentTeam = { id: 'team-1' }
  h.daemonTeam = null
  h.probeOk = true
  h.inviteShouldThrow = false
  h.initShouldThrow = false
  h.registerShouldThrow = false
  h.invokeCalls = []
  localStorage.clear()
  useDaemonOnboardingStore.setState({
    status: 'unknown',
    loaded: false,
    busy: false,
    error: null,
    ownedAgents: [],
    cloudAuthExpired: false,
    healing: false,
    healError: null,
    step: null,
    completedSteps: [],
    failedStep: null,
    runStartedAt: null,
    completedAgent: null,
  })
})

describe('daemon-onboarding step model', () => {
  it('records the steps a successful onboard walks through', async () => {
    await useDaemonOnboardingStore.getState().createNewAgent('Mac', 'personal')
    const { completedSteps, step, failedStep } = useDaemonOnboardingStore.getState()
    expect(completedSteps.slice(0, 3)).toEqual(['mint-invite', 'init-daemon', 'restart-daemon'])
    // Nothing left in flight, and nothing blamed.
    expect(step).toBeNull()
    expect(failedStep).toBeNull()
  })

  it('names the step that failed', async () => {
    h.initShouldThrow = true
    await useDaemonOnboardingStore.getState().createNewAgent('Mac', 'personal')
    const s = useDaemonOnboardingStore.getState()
    expect(s.failedStep).toBe('init-daemon')
    expect(s.completedSteps).toEqual(['mint-invite'])
    expect(s.error).toContain('init boom')
  })

  it('blames the first failing step, not a later one', async () => {
    h.inviteShouldThrow = true
    await useDaemonOnboardingStore.getState().createNewAgent('Mac', 'personal')
    expect(useDaemonOnboardingStore.getState().failedStep).toBe('mint-invite')
    expect(useDaemonOnboardingStore.getState().completedSteps).toEqual([])
    // It never got as far as touching the daemon.
    expect(h.invokeCalls).not.toContain('daemon_init')
  })

  it('clears the previous run before starting another', async () => {
    h.initShouldThrow = true
    await useDaemonOnboardingStore.getState().createNewAgent('Mac', 'personal')
    expect(useDaemonOnboardingStore.getState().failedStep).toBe('init-daemon')

    h.initShouldThrow = false
    await useDaemonOnboardingStore.getState().createNewAgent('Mac', 'personal')
    const s = useDaemonOnboardingStore.getState()
    expect(s.failedStep).toBeNull()
    expect(s.completedSteps.filter((x) => x === 'mint-invite')).toHaveLength(1)
  })

  it('remembers which agent was set up so the wizard can confirm it', async () => {
    await useDaemonOnboardingStore.getState().createNewAgent('Mac mini', 'personal')
    expect(useDaemonOnboardingStore.getState().completedAgent).toEqual({
      agentId: 'actor-1',
      displayName: 'Mac mini',
    })
  })

  // Workspace registration is best-effort; a failure there must not present as
  // a failed onboard.
  it('does not blame a step for the best-effort workspace registration', async () => {
    h.registerShouldThrow = true
    await useDaemonOnboardingStore.getState().createNewAgent('Mac', 'personal')
    const s = useDaemonOnboardingStore.getState()
    expect(s.failedStep).toBeNull()
    expect(s.status).toBe('ready')
  })
})

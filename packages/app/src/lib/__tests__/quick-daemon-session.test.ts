import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getLocalDaemonAgent: vi.fn(),
  resolveCurrentMemberActorId: vi.fn(),
  createSessionShell: vi.fn(),
  ensureSessionLiveSubscribed: vi.fn(),
  sessionListLoad: vi.fn(),
  switchToSession: vi.fn(),
  requestComposerFocus: vi.fn(),
  setAgents: vi.fn(),
  addHighlightedSession: vi.fn(),
  clearDraftIdeaId: vi.fn(),
  draftIdeaId: null as string | null,
}))

vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonAgent: (...a: unknown[]) => mocks.getLocalDaemonAgent(...a),
}))
vi.mock('@/lib/current-actor', () => ({
  resolveCurrentMemberActorId: (...a: unknown[]) => mocks.resolveCurrentMemberActorId(...a),
}))
vi.mock('@/lib/session-create', () => ({
  createSessionShell: (...a: unknown[]) => mocks.createSessionShell(...a),
}))
vi.mock('@/lib/session-live-subscriptions', () => ({
  ensureSessionLiveSubscribed: (...a: unknown[]) => mocks.ensureSessionLiveSubscribed(...a),
}))
vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: { getState: () => ({ load: mocks.sessionListLoad }) },
}))
vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({
      switchToSession: mocks.switchToSession,
      requestComposerFocus: mocks.requestComposerFocus,
      draftIdeaId: mocks.draftIdeaId,
      clearDraftIdeaId: mocks.clearDraftIdeaId,
    }),
  },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: { getState: () => ({ addHighlightedSession: mocks.addHighlightedSession }) },
}))
vi.mock('@/stores/engaged-agent-store', () => ({
  useEngagedAgentStore: { getState: () => ({ setAgents: mocks.setAgents }) },
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ session: { user: { id: 'user-1' } } }) },
}))
vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-1' }, currentMember: { id: 'mem-1' } }),
  },
}))
vi.mock('@/lib/teamclaw/ensure-agent-runtime', () => ({
  ensureAgentRuntimesForSession: vi.fn().mockResolvedValue(undefined),
}))

describe('createQuickDaemonSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.draftIdeaId = null
    mocks.getLocalDaemonAgent.mockResolvedValue({
      id: 'agent-mac',
      displayName: 'MACPRO AI',
    })
    mocks.resolveCurrentMemberActorId.mockResolvedValue('actor-me')
    mocks.createSessionShell.mockResolvedValue({ sessionId: 'sess-new' })
    mocks.ensureSessionLiveSubscribed.mockResolvedValue(undefined)
    mocks.sessionListLoad.mockResolvedValue(undefined)
    mocks.switchToSession.mockResolvedValue(undefined)
  })

  it('returns null when no local daemon agent', async () => {
    mocks.getLocalDaemonAgent.mockResolvedValue(null)
    const { createQuickDaemonSession } = await import('../quick-daemon-session')
    const result = await createQuickDaemonSession()
    expect(result).toBeNull()
    expect(mocks.createSessionShell).not.toHaveBeenCalled()
  })

  it('creates shell with creator + agent and switches session', async () => {
    const { createQuickDaemonSession } = await import('../quick-daemon-session')
    const result = await createQuickDaemonSession()
    expect(result).toEqual({ sessionId: 'sess-new', agentDisplayName: 'MACPRO AI' })
    expect(mocks.createSessionShell).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'team-1',
        creatorActorId: 'actor-me',
        additionalActorIds: ['agent-mac'],
        title: expect.stringMatching(/^MACPRO AI \(\d{2}:\d{2}\)$/),
      }),
    )
    expect(mocks.setAgents).toHaveBeenCalledWith('sess-new', [
      { id: 'agent-mac', displayName: 'MACPRO AI' },
    ])
    expect(mocks.switchToSession).toHaveBeenCalledWith('sess-new')
    expect(mocks.requestComposerFocus).toHaveBeenCalled()
  })
})

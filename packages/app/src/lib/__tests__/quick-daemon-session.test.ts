import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getLocalDaemonAgent: vi.fn(),
  enterActorDraft: vi.fn(),
  requestComposerFocus: vi.fn(),
}))

vi.mock('@/lib/daemon-agent-admin', () => ({
  getLocalDaemonAgent: (...a: unknown[]) => mocks.getLocalDaemonAgent(...a),
}))

vi.mock('@/stores/ui', () => ({
  useUIStore: {
    getState: () => ({
      enterActorDraft: mocks.enterActorDraft,
      requestComposerFocus: mocks.requestComposerFocus,
    }),
  },
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-1' }, currentMember: { id: 'mem-1' } }),
  },
}))

describe('createQuickDaemonSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLocalDaemonAgent.mockResolvedValue({
      id: 'agent-mac',
      displayName: 'MACPRO AI',
    })
  })

  it('returns null when no local daemon agent', async () => {
    mocks.getLocalDaemonAgent.mockResolvedValue(null)
    const { createQuickDaemonSession } = await import('../quick-daemon-session')
    const result = await createQuickDaemonSession()
    expect(result).toBeNull()
    expect(mocks.enterActorDraft).not.toHaveBeenCalled()
  })

  it('enters draft with local agent without creating a session', async () => {
    const { createQuickDaemonSession } = await import('../quick-daemon-session')
    const result = await createQuickDaemonSession()
    expect(result).toEqual({ agentDisplayName: 'MACPRO AI' })
    expect(mocks.enterActorDraft).toHaveBeenCalledWith({
      id: 'agent-mac',
      displayName: 'MACPRO AI',
      kind: 'agent',
    })
    expect(mocks.requestComposerFocus).toHaveBeenCalled()
  })
})

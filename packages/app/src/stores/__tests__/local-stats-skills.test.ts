import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
const insertSkillUsageMock = vi.fn()
const resolveCurrentMemberActorIdMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('../telemetry', () => ({
  triggerTeamLeaderboardExport: vi.fn(),
}))

vi.mock('@/stores/current-team', () => ({
  useCurrentTeamStore: {
    getState: () => ({ team: { id: 'team-abc' } }),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ session: { user: { id: 'user-xyz' } } }),
  },
}))

vi.mock('@/lib/current-actor', () => ({
  resolveCurrentMemberActorId: (...args: unknown[]) =>
    resolveCurrentMemberActorIdMock(...args),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({
    telemetry: {
      insertSkillUsage: (...args: unknown[]) => insertSkillUsageMock(...args),
    },
  }),
}))

const statsShape = {
  version: '1.0.0',
  taskCompleted: 0,
  totalTokens: 0,
  totalCost: 0,
  feedbackCount: 0,
  positiveCount: 0,
  negativeCount: 0,
  starRatings: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  sessions: { total: 0, withFeedback: 0 },
  lastUpdated: 'x',
  createdAt: 'x',
  skillUsage: { 'sentry-fix': 1 },
}

describe('incrementSkillUsage', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(statsShape)
    insertSkillUsageMock.mockReset()
    insertSkillUsageMock.mockResolvedValue(undefined)
    resolveCurrentMemberActorIdMock.mockReset()
    resolveCurrentMemberActorIdMock.mockResolvedValue('actor-123')
  })

  it('calls update_local_stats with skillInvoked set to the given name', async () => {
    const { useLocalStatsStore } = await import('../local-stats')

    await useLocalStatsStore.getState().incrementSkillUsage('/w', 'sentry-fix')

    expect(invokeMock).toHaveBeenCalledWith('update_local_stats', {
      workspacePath: '/w',
      updates: { skillInvoked: 'sentry-fix' },
    })
  })

  it('mirrors to cloud with correct actorId, teamId, skill, and count', async () => {
    const { useLocalStatsStore } = await import('../local-stats')

    await useLocalStatsStore.getState().incrementSkillUsage('/w', 'sentry-fix')

    expect(resolveCurrentMemberActorIdMock).toHaveBeenCalledWith('team-abc', 'user-xyz')
    expect(insertSkillUsageMock).toHaveBeenCalledWith({
      actorId: 'actor-123',
      teamId: 'team-abc',
      skill: 'sentry-fix',
      count: 1,
    })
  })

  it('cloud failure does not throw and local write still completes', async () => {
    insertSkillUsageMock.mockRejectedValue(new Error('network error'))

    const { useLocalStatsStore } = await import('../local-stats')

    // Should not throw
    await expect(
      useLocalStatsStore.getState().incrementSkillUsage('/w', 'sentry-fix'),
    ).resolves.toBeUndefined()

    // Local write still happened
    expect(invokeMock).toHaveBeenCalledWith('update_local_stats', {
      workspacePath: '/w',
      updates: { skillInvoked: 'sentry-fix' },
    })
  })

  it('skips cloud mirror when actor cannot be resolved', async () => {
    resolveCurrentMemberActorIdMock.mockResolvedValue(null)

    const { useLocalStatsStore } = await import('../local-stats')

    await useLocalStatsStore.getState().incrementSkillUsage('/w', 'sentry-fix')

    // Local write happened
    expect(invokeMock).toHaveBeenCalledWith('update_local_stats', expect.any(Object))
    // Cloud call skipped
    expect(insertSkillUsageMock).not.toHaveBeenCalled()
  })

  it('skips empty skill name', async () => {
    const { useLocalStatsStore } = await import('../local-stats')

    await useLocalStatsStore.getState().incrementSkillUsage('/w', '')

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('skips empty workspace path', async () => {
    const { useLocalStatsStore } = await import('../local-stats')

    await useLocalStatsStore.getState().incrementSkillUsage('', 'foo')

    expect(invokeMock).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/lib/utils', () => ({
  isTauri: () => true,
}))

vi.mock('../telemetry', () => ({
  triggerTeamLeaderboardExport: vi.fn(),
}))

describe('incrementSkillUsage', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue({
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
    })
  })

  it('calls update_local_stats with skillInvoked set to the given name', async () => {
    const { useLocalStatsStore } = await import('../local-stats')

    await useLocalStatsStore.getState().incrementSkillUsage('/w', 'sentry-fix')

    expect(invokeMock).toHaveBeenCalledWith('update_local_stats', {
      workspacePath: '/w',
      updates: { skillInvoked: 'sentry-fix' },
    })
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

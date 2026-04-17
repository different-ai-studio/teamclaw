import { describe, it, expect } from 'vitest'
import { computeTopSkills } from '../LeaderboardSection'
import type { TeamLeaderboard } from '../LeaderboardSection'

describe('computeTopSkills', () => {
  it('aggregates skill counts across all members and workspaces, sorted desc', () => {
    const leaderboard: TeamLeaderboard = {
      members: [
        {
          memberId: 'a',
          memberName: 'Alice',
          exportedAt: '',
          updateAt: '',
          workspaces: {
            '/w1': {
              totalFeedbacks: 0, positiveCount: 0, negativeCount: 0,
              totalTokens: 0, totalCost: 0, sessionCount: 0,
              skillUsage: { 'sentry-fix': 10, 'fc-deploy': 5 },
            },
            '/w2': {
              totalFeedbacks: 0, positiveCount: 0, negativeCount: 0,
              totalTokens: 0, totalCost: 0, sessionCount: 0,
              skillUsage: { 'sentry-fix': 3 },
            },
          },
        },
        {
          memberId: 'b',
          memberName: 'Bob',
          exportedAt: '',
          updateAt: '',
          workspaces: {
            '/w1': {
              totalFeedbacks: 0, positiveCount: 0, negativeCount: 0,
              totalTokens: 0, totalCost: 0, sessionCount: 0,
              skillUsage: { 'fc-deploy': 7 },
            },
          },
        },
      ],
    }

    const top = computeTopSkills(leaderboard, 10)
    expect(top).toEqual([
      { name: 'sentry-fix', count: 13, userCount: 1 },
      { name: 'fc-deploy', count: 12, userCount: 2 },
    ])
  })

  it('returns empty array when no skills are used', () => {
    expect(computeTopSkills({ members: [] }, 10)).toEqual([])
  })

  it('caps at the limit', () => {
    const members = Array.from({ length: 15 }, (_, i) => ({
      memberId: `m${i}`,
      memberName: `M${i}`,
      exportedAt: '', updateAt: '',
      workspaces: {
        '/w': {
          totalFeedbacks: 0, positiveCount: 0, negativeCount: 0,
          totalTokens: 0, totalCost: 0, sessionCount: 0,
          skillUsage: { [`skill-${i}`]: i + 1 },
        },
      },
    }))
    const top = computeTopSkills({ members }, 10)
    expect(top).toHaveLength(10)
  })
})

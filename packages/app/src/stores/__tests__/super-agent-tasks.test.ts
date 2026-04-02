import { describe, it, expect } from 'vitest'
import { isTaskBoardSnapshot } from '../super-agent'

describe('isTaskBoardSnapshot', () => {
  it('returns true for valid snapshot', () => {
    expect(isTaskBoardSnapshot({ tasks: [] })).toBe(true)
  })

  it('returns true for snapshot with tasks', () => {
    expect(
      isTaskBoardSnapshot({
        tasks: [{
          id: 't1', creator: 'node-a', description: 'Test',
          requiredCapabilities: [], urgency: 'normal', complexity: 'delegate',
          status: 'bidding', bids: [], assignee: null, result: null,
          createdAt: 1000, updatedAt: 1000,
        }],
      }),
    ).toBe(true)
  })

  it('returns false for null', () => {
    expect(isTaskBoardSnapshot(null)).toBe(false)
  })

  it('returns false for missing tasks', () => {
    expect(isTaskBoardSnapshot({})).toBe(false)
  })

  it('returns false for non-array tasks', () => {
    expect(isTaskBoardSnapshot({ tasks: 'not-array' })).toBe(false)
  })
})

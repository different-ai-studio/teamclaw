import { describe, it, expect } from 'vitest'
import { isKnowledgeSnapshot } from '../super-agent'

describe('isKnowledgeSnapshot', () => {
  it('returns true for a valid empty snapshot', () => {
    expect(
      isKnowledgeSnapshot({ experiences: [], strategies: [], distilledSkills: [] }),
    ).toBe(true)
  })

  it('returns false for null', () => {
    expect(isKnowledgeSnapshot(null)).toBe(false)
  })

  it('returns false when fields are missing', () => {
    expect(isKnowledgeSnapshot({ experiences: [], strategies: [] })).toBe(false)
  })

  it('returns false when fields are not arrays', () => {
    expect(
      isKnowledgeSnapshot({ experiences: 'no', strategies: 42, distilledSkills: null }),
    ).toBe(false)
  })
})

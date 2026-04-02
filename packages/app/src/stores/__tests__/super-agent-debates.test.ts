import { describe, it, expect } from 'vitest'
import { isDebateSnapshot } from '../super-agent'

describe('isDebateSnapshot', () => {
  it('returns true for a valid empty snapshot', () => {
    expect(isDebateSnapshot({ debates: [] })).toBe(true)
  })

  it('returns false for null', () => {
    expect(isDebateSnapshot(null)).toBe(false)
  })

  it('returns false when debates field is missing', () => {
    expect(isDebateSnapshot({})).toBe(false)
  })

  it('returns false when debates is not an array', () => {
    expect(isDebateSnapshot({ debates: 'not-an-array' })).toBe(false)
  })
})

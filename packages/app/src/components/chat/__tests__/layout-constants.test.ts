import { describe, it, expect } from 'vitest'
import { SAFE_BOTTOM_SPACING, NEAR_BOTTOM_THRESHOLD } from '../layout-constants'

describe('layout-constants', () => {
  it('SAFE_BOTTOM_SPACING should be at least 32px to prevent overlap', () => {
    // Must be large enough to account for:
    // - ChatInputArea pt-8 (32px) with 30% transparent gradient (~10px)
    // - Sub-pixel rounding and ResizeObserver timing
    expect(SAFE_BOTTOM_SPACING).toBeGreaterThanOrEqual(32)
  })

  it('NEAR_BOTTOM_THRESHOLD should be larger than SAFE_BOTTOM_SPACING', () => {
    // Must provide buffer to avoid false-positive "user scrolled up" detection
    expect(NEAR_BOTTOM_THRESHOLD).toBeGreaterThan(SAFE_BOTTOM_SPACING + 50)
  })

  it('constants should be positive integers', () => {
    expect(SAFE_BOTTOM_SPACING).toBeGreaterThan(0)
    expect(NEAR_BOTTOM_THRESHOLD).toBeGreaterThan(0)
    expect(Number.isInteger(SAFE_BOTTOM_SPACING)).toBe(true)
    expect(Number.isInteger(NEAR_BOTTOM_THRESHOLD)).toBe(true)
  })
})

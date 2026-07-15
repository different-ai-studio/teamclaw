import { describe, it, expect } from 'vitest'
import { computeOnboardingStatus } from '../daemon-onboarding'

describe('computeOnboardingStatus', () => {
  it('unknown when no current team yet', () => {
    expect(computeOnboardingStatus(null, null)).toBe('unknown')
    expect(computeOnboardingStatus('t1', null)).toBe('unknown')
  })
  it('needs-onboard when daemon has no team', () => {
    expect(computeOnboardingStatus(null, 't1')).toBe('needs-onboard')
  })
  it('ready when daemon team matches current team', () => {
    expect(computeOnboardingStatus('t1', 't1')).toBe('ready')
  })
  it('mismatch when daemon team differs from current team', () => {
    expect(computeOnboardingStatus('t2', 't1')).toBe('mismatch')
  })
})

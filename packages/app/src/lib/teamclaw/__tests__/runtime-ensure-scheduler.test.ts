import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordRuntimeEnsureAttempt,
  resetRuntimeEnsureThrottle,
  runtimeEnsureKey,
  shouldSkipThrottledRuntimeEnsure,
} from '@/lib/teamclaw/runtime-ensure-scheduler'

describe('runtime-ensure-scheduler', () => {
  beforeEach(() => {
    resetRuntimeEnsureThrottle()
  })

  it('does not skip before any attempt is recorded', () => {
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(false)
  })

  it('skips duplicate attempts within the throttle window', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(true)
  })

  it('does not skip a different session or agent set', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    expect(shouldSkipThrottledRuntimeEnsure('session-b', ['agent-1'])).toBe(false)
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-2'])).toBe(false)
  })

  it('reset clears throttle state', () => {
    recordRuntimeEnsureAttempt('session-a', ['agent-1'])
    resetRuntimeEnsureThrottle()
    expect(shouldSkipThrottledRuntimeEnsure('session-a', ['agent-1'])).toBe(false)
  })

  it('runtimeEnsureKey is stable regardless of agent order', () => {
    expect(runtimeEnsureKey('s', ['b', 'a'])).toBe(runtimeEnsureKey('s', ['a', 'b']))
  })
})

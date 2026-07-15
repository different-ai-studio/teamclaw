import { afterEach, describe, expect, it, vi } from 'vitest'
import { devSkipDaemonOnboarding, devSkipSetup } from '../dev-onboarding-flags'

describe('dev-onboarding-flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to false when env vars are unset', () => {
    expect(devSkipSetup()).toBe(false)
    expect(devSkipDaemonOnboarding()).toBe(false)
  })

  it('reads VITE_TEAMCLAW_SKIP_* from import.meta.env', () => {
    vi.stubEnv('VITE_TEAMCLAW_SKIP_SETUP', 'true')
    vi.stubEnv('VITE_TEAMCLAW_SKIP_DAEMON_ONBOARDING', 'true')
    expect(devSkipSetup()).toBe(true)
    expect(devSkipDaemonOnboarding()).toBe(true)
  })
})

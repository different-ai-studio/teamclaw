import { describe, it, expect, beforeEach, vi } from 'vitest'

// The runtime pick is the one piece of wizard state that has nowhere to go when
// it is made: `agents.local_agent` is team-scoped and the setup step runs before
// sign-in. It waits in localStorage until the machine's agent is bound.
describe('onboarding runtime pick', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('survives a quit between the setup step and sign-in', async () => {
    const { useOnboardingStore } = await import('../onboarding')
    useOnboardingStore.getState().setRuntime('pi')

    // A fresh load of the module — the app restarted.
    vi.resetModules()
    const reloaded = await import('../onboarding')
    expect(reloaded.useOnboardingStore.getState().runtime).toBe('pi')
  })

  it('forgets it once applied, and on reset', async () => {
    const { useOnboardingStore } = await import('../onboarding')
    useOnboardingStore.getState().setRuntime('cursor')
    useOnboardingStore.getState().clearRuntime()
    expect(useOnboardingStore.getState().runtime).toBeNull()

    vi.resetModules()
    expect((await import('../onboarding')).useOnboardingStore.getState().runtime).toBeNull()

    const again = await import('../onboarding')
    again.useOnboardingStore.getState().setRuntime('claude-code')
    again.useOnboardingStore.getState().reset()
    vi.resetModules()
    expect((await import('../onboarding')).useOnboardingStore.getState().runtime).toBeNull()
  })

  it('ignores a value that is not a runtime this build can drive', async () => {
    localStorage.setItem('teamclu-onboarding-runtime', 'codex')
    const { useOnboardingStore } = await import('../onboarding')
    expect(useOnboardingStore.getState().runtime).toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

describe('isInternalBuild', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('is false when VITE_INTERNAL is unset', async () => {
    vi.stubEnv('VITE_INTERNAL', undefined)
    const { isInternalBuild } = await import('../internal-build')
    expect(isInternalBuild()).toBe(false)
  })

  it('is true when VITE_INTERNAL is "true"', async () => {
    vi.stubEnv('VITE_INTERNAL', 'true')
    const { isInternalBuild } = await import('../internal-build')
    expect(isInternalBuild()).toBe(true)
  })

  it('is true when VITE_INTERNAL is "1"', async () => {
    vi.stubEnv('VITE_INTERNAL', '1')
    const { isInternalBuild } = await import('../internal-build')
    expect(isInternalBuild()).toBe(true)
  })
})

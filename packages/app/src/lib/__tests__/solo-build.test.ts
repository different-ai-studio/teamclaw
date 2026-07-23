import { afterEach, describe, expect, it, vi } from 'vitest'

describe('isSoloBuild', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('is false when VITE_SOLO is unset', async () => {
    vi.stubEnv('VITE_SOLO', undefined)
    const { isSoloBuild } = await import('../solo-build')
    expect(isSoloBuild()).toBe(false)
  })

  it('is true when VITE_SOLO is "true"', async () => {
    vi.stubEnv('VITE_SOLO', 'true')
    const { isSoloBuild } = await import('../solo-build')
    expect(isSoloBuild()).toBe(true)
  })

  it('is true when VITE_SOLO is "1"', async () => {
    vi.stubEnv('VITE_SOLO', '1')
    const { isSoloBuild } = await import('../solo-build')
    expect(isSoloBuild()).toBe(true)
  })
})

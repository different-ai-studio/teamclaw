import { beforeEach, describe, expect, it, vi } from 'vitest'

const storageState = vi.hoisted(() => ({
  bag: {} as Record<string, unknown>,
}))

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        const key = Array.isArray(keys) ? keys[0]! : keys
        return key in storageState.bag ? { [key]: storageState.bag[key] } : {}
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(storageState.bag, items)
      }),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
})

describe('readLinkHoverConfig bake seed', () => {
  beforeEach(() => {
    storageState.bag = {}
    vi.resetModules()
  })

  it('seeds chrome.storage from baked defaults when unset', async () => {
    const mod = await import('./chrome-storage')
    vi.spyOn(mod, 'getBakedLinkHoverConfig').mockReturnValue({
      domains: ['accounting.i.shopee.io'],
      urlPatterns: ['*/discrepancy-details-info-v2/*'],
    })

    const config = await mod.readLinkHoverConfig()
    expect(config).toEqual({
      domains: ['accounting.i.shopee.io'],
      urlPatterns: ['*/discrepancy-details-info-v2/*'],
    })
    expect(storageState.bag['teamclaw.extension.linkHover']).toEqual({
      domains: ['accounting.i.shopee.io'],
      urlPatterns: ['*/discrepancy-details-info-v2/*'],
    })
  })

  it('returns existing chrome.storage value without reseeding', async () => {
    storageState.bag['teamclaw.extension.linkHover'] = {
      domains: ['example.com'],
      urlPatterns: ['*/other/*'],
    }
    const mod = await import('./chrome-storage')
    vi.spyOn(mod, 'getBakedLinkHoverConfig').mockReturnValue({
      domains: ['accounting.i.shopee.io'],
      urlPatterns: ['*/discrepancy-details-info-v2/*'],
    })

    const config = await mod.readLinkHoverConfig()
    expect(config).toEqual({
      domains: ['example.com'],
      urlPatterns: ['*/other/*'],
    })
  })
})

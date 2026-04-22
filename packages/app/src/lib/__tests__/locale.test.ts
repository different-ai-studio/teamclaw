import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appShortName } from '@/lib/build-config'

const store: Record<string, string> = {}

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val },
  removeItem: (key: string) => { delete store[key] },
  clear: () => { Object.keys(store).forEach((key) => delete store[key]) },
})

function setNavigatorLanguage(language: string, languages: string[] = [language]) {
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: language,
  })
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    value: languages,
  })
}

describe('locale helpers', () => {
  beforeEach(() => {
    Object.keys(store).forEach((key) => delete store[key])
    vi.resetModules()
  })

  it('uses the system language when there is no saved language', async () => {
    setNavigatorLanguage('zh-CN')

    const { getPreferredLanguage } = await import('../locale')

    expect(getPreferredLanguage()).toBe('zh-CN')
  })

  it('prefers a saved language over the system language', async () => {
    setNavigatorLanguage('zh-CN')
    store[`${appShortName}-language`] = 'en'

    const { getPreferredLanguage } = await import('../locale')

    expect(getPreferredLanguage()).toBe('en')
  })

  it('falls back to English for unsupported system languages', async () => {
    setNavigatorLanguage('fr-FR')

    const { getPreferredLanguage } = await import('../locale')

    expect(getPreferredLanguage()).toBe('en')
  })
})

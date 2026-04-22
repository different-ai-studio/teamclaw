import { beforeEach, describe, expect, it, vi } from 'vitest'

const store: Record<string, string> = {}

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val },
  removeItem: (key: string) => { delete store[key] },
  clear: () => { Object.keys(store).forEach((key) => delete store[key]) },
})

function setNavigatorLanguage(language: string) {
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: language,
  })
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    value: [language],
  })
}

describe('number-format system locale fallback', () => {
  beforeEach(() => {
    Object.keys(store).forEach((key) => delete store[key])
    vi.resetModules()
  })

  it('uses the system language when no saved language exists', async () => {
    setNavigatorLanguage('zh-CN')

    const numberFormatSpy = vi.spyOn(Intl, 'NumberFormat')

    const { formatNumber } = await import('../number-format')
    formatNumber(1234)

    expect(numberFormatSpy).toHaveBeenCalledWith('zh-CN', {})

    numberFormatSpy.mockRestore()
  })
})

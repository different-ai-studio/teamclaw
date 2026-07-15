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

describe('number-format default locale', () => {
  beforeEach(() => {
    Object.keys(store).forEach((key) => delete store[key])
    vi.resetModules()
  })

  it('defaults to English number formatting when no saved language exists', async () => {
    // System language is intentionally not auto-detected — English is the default.
    setNavigatorLanguage('zh-CN')

    // vitest 4: spyOn no longer calls the original constructor through, so we
    // restore call-through explicitly to keep `.format()` working.
    const OrigNumberFormat = Intl.NumberFormat
    const numberFormatSpy = vi
      .spyOn(Intl, 'NumberFormat')
      .mockImplementation(function (...args: unknown[]) {
        return new (OrigNumberFormat as unknown as new (...a: unknown[]) => Intl.NumberFormat)(...args)
      } as unknown as typeof Intl.NumberFormat)

    const { formatNumber } = await import('../number-format')
    formatNumber(1234)

    expect(numberFormatSpy).toHaveBeenCalledWith('en', {})

    numberFormatSpy.mockRestore()
  })
})

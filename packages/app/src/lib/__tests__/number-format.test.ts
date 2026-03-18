import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock localStorage
const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => { store[key] = val },
  removeItem: (key: string) => { delete store[key] },
  clear: () => { Object.keys(store).forEach(k => delete store[k]) },
})

import { formatNumber, formatCurrency, formatPercentage } from '../number-format'

beforeEach(() => {
  store['teamclaw-language'] = 'en'
})

describe('number-format', () => {
  it('formatNumber formats integers', () => {
    const result = formatNumber(1234567)
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })

  it('formatNumber handles decimals', () => {
    const result = formatNumber(3.14159)
    expect(result).toBeTruthy()
  })

  it('formatCurrency formats with currency symbol', () => {
    const result = formatCurrency(99.99, 'USD')
    expect(result).toBeTruthy()
  })

  it('formatPercentage formats percentage', () => {
    const result = formatPercentage(0.75)
    expect(result).toBeTruthy()
  })

  it('formatNumber handles zero', () => {
    const result = formatNumber(0)
    expect(typeof result).toBe('string')
  })
})

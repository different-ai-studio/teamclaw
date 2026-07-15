import { describe, expect, it } from 'vitest'
import { detectDarkContext, isDarkBackgroundLuminance, luminanceFromCssColor } from './link-hover-theme'

describe('luminanceFromCssColor', () => {
  it('parses rgb', () => {
    expect(luminanceFromCssColor('rgb(15, 23, 42)')).toBeCloseTo(0.09, 1)
    expect(luminanceFromCssColor('rgb(255, 255, 255)')).toBeCloseTo(1, 1)
  })
})

describe('detectDarkContext', () => {
  it('detects dark ancestor backgrounds', () => {
    const dark = detectDarkContext(
      { parentElement: { parentElement: null } } as unknown as Element,
      () => 'rgb(15, 23, 42)',
    )
    expect(dark).toBe(true)
  })

  it('treats white backgrounds as light', () => {
    const light = detectDarkContext(
      { parentElement: null } as unknown as Element,
      () => 'rgb(255, 255, 255)',
    )
    expect(light).toBe(false)
    expect(isDarkBackgroundLuminance(0.9)).toBe(false)
  })
})

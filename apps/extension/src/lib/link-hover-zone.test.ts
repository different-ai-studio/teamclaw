import { describe, expect, it } from 'vitest'
import { isLinkHoverTargetVisible, isPointerInHoverKeepZone } from './link-hover-zone'

describe('isPointerInHoverKeepZone', () => {
  const linkRight = { left: 40, top: 100, right: 140, bottom: 120, width: 100, height: 20 }
  const hostRight = { left: 148, top: 96, right: 244, bottom: 124, width: 96, height: 28 }

  it('keeps zone over link, gap, and button (button on right)', () => {
    expect(isPointerInHoverKeepZone(80, 110, linkRight, hostRight)).toBe(true)
    expect(isPointerInHoverKeepZone(144, 110, linkRight, hostRight)).toBe(true)
    expect(isPointerInHoverKeepZone(200, 110, linkRight, hostRight)).toBe(true)
  })

  it('drops outside the corridor', () => {
    expect(isPointerInHoverKeepZone(144, 60, linkRight, hostRight)).toBe(false)
    expect(isPointerInHoverKeepZone(300, 110, linkRight, hostRight)).toBe(false)
  })

  it('bridges when button is on the left', () => {
    const hostLeft = { left: 20, top: 96, right: 116, bottom: 124, width: 96, height: 28 }
    expect(isPointerInHoverKeepZone(130, 110, linkRight, hostLeft)).toBe(true)
    expect(isPointerInHoverKeepZone(118, 110, linkRight, hostLeft)).toBe(true)
  })
})

describe('isLinkHoverTargetVisible', () => {
  const visible = {
    isConnected: true,
    rect: { width: 80, height: 20 } as DOMRect,
    display: 'inline',
    visibility: 'visible',
    opacity: '1',
  }

  it('rejects detached or zero-size links', () => {
    expect(isLinkHoverTargetVisible({} as Element, () => ({ ...visible, isConnected: false }))).toBe(false)
    expect(
      isLinkHoverTargetVisible({} as Element, () => ({
        ...visible,
        rect: { width: 0, height: 0 } as DOMRect,
      })),
    ).toBe(false)
  })

  it('rejects links hidden by an ancestor', () => {
    const parent = { parentElement: null } as unknown as Element
    const link = { parentElement: parent } as unknown as Element
    const read = (el: Element): ElementVisibilityProbe => {
      if (el === link) return visible
      if (el === parent) return { ...visible, display: 'none' }
      return visible
    }
    expect(isLinkHoverTargetVisible(link, read)).toBe(false)
  })
})

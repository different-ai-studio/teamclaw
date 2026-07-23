import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  findActionableLinkFromTarget,
  getLinkHoverBrandLabel,
  isActionableLink,
  isHoverableLink,
} from './link-hover'

function fakeAnchor(href: string, localName = 'a'): HTMLAnchorElement {
  return {
    localName,
    tagName: localName.toUpperCase(),
    href,
    getAttribute: (name: string) => (name === 'href' ? href : null),
    closest: function (this: HTMLAnchorElement, sel: string) {
      return sel === 'a' ? this : null
    },
  } as unknown as HTMLAnchorElement
}

describe('getLinkHoverBrandLabel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads chrome.runtime.getManifest().name', () => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ name: 'Copilot361' }) },
    })
    expect(getLinkHoverBrandLabel()).toBe('Copilot361')
  })

  it('falls back when manifest name is missing', () => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({}) },
    })
    expect(getLinkHoverBrandLabel()).toBe('TeamClaw')
  })
})

describe('isActionableLink', () => {
  it('accepts http(s) links', () => {
    expect(isActionableLink(fakeAnchor('https://example.com/a'))).toBe(true)
    expect(isActionableLink(fakeAnchor('http://localhost/x'))).toBe(true)
  })

  it('rejects non-navigational links', () => {
    expect(isActionableLink(fakeAnchor('mailto:a@b.c'))).toBe(false)
    expect(isActionableLink(fakeAnchor('javascript:void(0)'))).toBe(false)
    expect(isActionableLink(fakeAnchor('#section'))).toBe(false)
    expect(isActionableLink(fakeAnchor('https://x', 'span'))).toBe(false)
  })
})

describe('isHoverableLink', () => {
  it('applies the url matcher on top of actionable links', () => {
    const link = fakeAnchor('https://example.com/tickets/1')
    expect(isHoverableLink(link, () => true)).toBe(true)
    expect(isHoverableLink(link, (url) => url.includes('/tickets/'))).toBe(true)
    expect(isHoverableLink(link, () => false)).toBe(false)
    expect(isHoverableLink(fakeAnchor('#x'), () => true)).toBe(false)
  })
})

describe('findActionableLinkFromTarget', () => {
  it('walks up to the nearest anchor', () => {
    const a = fakeAnchor('https://example.com')
    const span = {
      closest: (sel: string) => (sel === 'a' ? a : null),
    } as unknown as Element
    expect(findActionableLinkFromTarget(span)).toBe(a)
  })

  it('respects the url matcher', () => {
    const a = fakeAnchor('https://example.com/home')
    const span = {
      closest: (sel: string) => (sel === 'a' ? a : null),
    } as unknown as Element
    expect(findActionableLinkFromTarget(span, () => false)).toBeNull()
  })
})

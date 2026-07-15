import { describe, expect, it } from 'vitest'
import { findActionableLinkFromTarget, isActionableLink } from './link-hover'

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

describe('findActionableLinkFromTarget', () => {
  it('walks up to the nearest anchor', () => {
    const a = fakeAnchor('https://example.com')
    const span = {
      closest: (sel: string) => (sel === 'a' ? a : null),
    } as unknown as Element
    expect(findActionableLinkFromTarget(span)).toBe(a)
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  isAllowedNavUrl,
  isSameOriginNavigation,
  navigateInDocument,
  resolveNavigationTarget,
  type NavigateContext,
} from './navigate'

function createNavigateContext(initialHref: string) {
  const state = { href: initialHref }
  const pushStateCalls: Array<{ state: unknown; url: string }> = []
  let popStateCount = 0

  const location = {
    get href() {
      return state.href
    },
    get origin() {
      return new URL(state.href).origin
    },
    get pathname() {
      return new URL(state.href).pathname
    },
    get search() {
      return new URL(state.href).search
    },
    get hash() {
      return new URL(state.href).hash
    },
    set hash(value: string) {
      const current = new URL(state.href)
      current.hash = value
      state.href = current.href
    },
    assign(url: string) {
      state.href = url
    },
  } as unknown as Location

  const ctx: NavigateContext & {
    href: string
    pushStateCalls: Array<{ state: unknown; url: string }>
    popStateCount: number
  } = {
    location,
    history: {
      state: null,
      pushState(nextState: unknown, _title: string, url: string) {
        pushStateCalls.push({ state: nextState, url })
        state.href = new URL(url, location.origin).href
      },
    },
    dispatchPopState: () => {
      popStateCount += 1
    },
    get href() {
      return state.href
    },
    pushStateCalls,
    get popStateCount() {
      return popStateCount
    },
  }

  return ctx
}

describe('navigate', () => {
  it('allows http(s), relative, and hash urls', () => {
    expect(isAllowedNavUrl('https://example.com')).toBe(true)
    expect(isAllowedNavUrl('/path')).toBe(true)
    expect(isAllowedNavUrl('#top')).toBe(true)
    expect(isAllowedNavUrl('javascript:alert(1)')).toBe(false)
  })

  it('detects same-origin absolute navigation', () => {
    expect(
      isSameOriginNavigation(
        'https://example.com/page',
        'https://example.com/page/details/1',
      ),
    ).toBe(true)
    expect(
      isSameOriginNavigation('https://example.com/page', 'https://other.example.com/page'),
    ).toBe(false)
  })

  it('uses pushState for same-origin absolute urls instead of assign', () => {
    const ctx = createNavigateContext('https://example.com/adminv2/home')
    navigateInDocument(ctx, 'https://example.com/adminv2/detail/42')

    expect(ctx.pushStateCalls).toEqual([
      { state: null, url: '/adminv2/detail/42' },
    ])
    expect(ctx.popStateCount).toBe(1)
    expect(ctx.href).toBe('https://example.com/adminv2/detail/42')
  })

  it('uses pushState for relative paths', () => {
    const ctx = createNavigateContext('https://example.com/adminv2/home')
    navigateInDocument(ctx, '/adminv2/detail/42')

    expect(ctx.pushStateCalls).toEqual([
      { state: null, url: '/adminv2/detail/42' },
    ])
    expect(ctx.popStateCount).toBe(1)
  })

  it('updates hash using location.hash for hash-only navigation', () => {
    const ctx = createNavigateContext('https://example.com/page')
    const assign = vi.spyOn(ctx.location, 'assign')
    navigateInDocument(ctx, '#intro')

    expect(ctx.pushStateCalls).toHaveLength(0)
    expect(ctx.popStateCount).toBe(0)
    expect(ctx.href).toBe('https://example.com/page#intro')
    expect(assign).not.toHaveBeenCalled()
  })

  it('falls back to assign for cross-origin urls', () => {
    const ctx = createNavigateContext('https://example.com/page')
    const assign = vi.spyOn(ctx.location, 'assign')

    navigateInDocument(ctx, 'https://other.example.com/page')

    expect(assign).toHaveBeenCalledWith('https://other.example.com/page')
    expect(ctx.pushStateCalls).toHaveLength(0)
  })

  it('resolves hash targets against current path', () => {
    const current = {
      pathname: '/adminv2/detail',
      search: '?tab=1',
      origin: 'https://example.com',
    } as unknown as Location
    const target = resolveNavigationTarget(current, '#detail')
    expect(target.pathname + target.search + target.hash).toBe('/adminv2/detail?tab=1#detail')
  })
})

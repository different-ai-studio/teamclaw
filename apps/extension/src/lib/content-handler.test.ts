import { describe, it, expect, vi } from 'vitest'
import { handleContentMessage } from './content-handler'
import type { NavigateContext } from './browser-tools/navigate'

const doc = { title: 'T', location: { href: 'u' }, body: { innerText: 'B' } } as unknown as Document

function createNavigateContext(initialHref: string): NavigateContext & {
  pushStateCalls: string[]
  popStateCount: number
} {
  const state = { href: initialHref }
  const pushStateCalls: string[] = []
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
    assign(url: string) {
      state.href = url
    },
  } as unknown as Location

  return {
    location,
    history: {
      state: null,
      pushState(_state: unknown, _title: string, url: string) {
        pushStateCalls.push(url)
        state.href = new URL(url, location.origin).href
      },
    },
    dispatchPopState: () => {
      popStateCount += 1
    },
    pushStateCalls,
    get popStateCount() {
      return popStateCount
    },
  }
}

const getSelection = () => null

describe('handleContentMessage', () => {
  it('returns a page-context for request-page', () => {
    const navigate = createNavigateContext('https://example.com/page')
    const out = handleContentMessage({ type: 'request-page' }, { doc, navigate, getSelection })
    expect(out?.type).toBe('page-context')
    expect(out?.payload.text).toBe('B')
  })
  it('returns null for unrelated messages', () => {
    const navigate = createNavigateContext('https://example.com/page')
    expect(handleContentMessage({ type: 'noop' }, { doc, navigate, getSelection })).toBeNull()
  })
  it('navigates same-origin urls via pushState', () => {
    const navigate = createNavigateContext('https://example.com/adminv2/home')
    const out = handleContentMessage(
      { type: 'navigate', url: 'https://example.com/adminv2/detail/1' },
      { doc, navigate, getSelection },
    )
    expect(out).toEqual({ ok: true })
    expect(navigate.pushStateCalls).toEqual(['/adminv2/detail/1'])
    expect(navigate.popStateCount).toBe(1)
  })
})

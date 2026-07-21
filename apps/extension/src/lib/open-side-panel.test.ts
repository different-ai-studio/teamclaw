import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openSidePanelFromUserGesture } from './open-side-panel'
import { openSidePanelMsg } from './messages'

type OpenCall = { tabId?: number; windowId?: number }
type SetOptionsCall = { tabId?: number; path?: string; enabled?: boolean }

describe('openSidePanelFromUserGesture', () => {
  const openCalls: OpenCall[] = []
  const setOptionsCalls: SetOptionsCall[] = []
  let openShouldFailOnce = false

  beforeEach(() => {
    openCalls.length = 0
    setOptionsCalls.length = 0
    openShouldFailOnce = false

    const storageSet = vi.fn(async () => {})
    ;(globalThis as { chrome: unknown }).chrome = {
      runtime: { lastError: undefined as { message: string } | undefined },
      storage: { session: { set: storageSet } },
      sidePanel: {
        open: (opts: OpenCall, cb: () => void) => {
          openCalls.push(opts)
          if (openShouldFailOnce && openCalls.length === 1) {
            ;(chrome.runtime as { lastError?: { message: string } }).lastError = {
              message: 'not enabled',
            }
            openShouldFailOnce = false
            cb()
            ;(chrome.runtime as { lastError?: { message: string } }).lastError = undefined
            return
          }
          ;(chrome.runtime as { lastError?: { message: string } }).lastError = undefined
          cb()
        },
        setOptions: (opts: SetOptionsCall, cb: () => void) => {
          setOptionsCalls.push(opts)
          ;(chrome.runtime as { lastError?: { message: string } }).lastError = undefined
          cb()
        },
      },
    }
  })

  it('opens with windowId only (global panel — no tabId)', async () => {
    const msg = openSidePanelMsg({
      page: {
        url: 'https://example.com',
        title: 't',
        selection: '',
        text: '',
        html: '',
      },
      linkKey: 'k',
      linkUrl: 'https://example.com',
      linkText: '',
      source: 'link-hover',
    })
    const result = await openSidePanelFromUserGesture(msg, 42)
    expect(result).toEqual({ ok: true })
    expect(openCalls).toEqual([{ windowId: 42 }])
    expect(openCalls[0]).not.toHaveProperty('tabId')
  })

  it('retry setOptions is global (no tabId path)', async () => {
    openShouldFailOnce = true
    const msg = openSidePanelMsg({
      page: {
        url: 'https://example.com',
        title: 't',
        selection: '',
        text: '',
        html: '',
      },
      linkKey: 'k',
      linkUrl: 'https://example.com',
      linkText: '',
      source: 'link-hover',
    })
    const result = await openSidePanelFromUserGesture(msg, 7)
    expect(result).toEqual({ ok: true })
    expect(setOptionsCalls).toEqual([{ path: 'sidepanel/index.html', enabled: true }])
    expect(setOptionsCalls.every((c) => c.tabId === undefined)).toBe(true)
    expect(openCalls.every((c) => c.tabId === undefined && c.windowId === 7)).toBe(true)
  })
})

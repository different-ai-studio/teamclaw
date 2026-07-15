import { describe, expect, it, vi } from 'vitest'

import { handleBrowserToolMessage } from './handle-browser-tool'
import { BROWSER_TOOL_MSG, BROWSER_TOOL_NAVIGATE } from './messages'

describe('handleBrowserToolMessage navigate', () => {
  it('routes same-origin absolute urls through content script', async () => {
    const injectContentScript = vi.fn(async () => undefined)
    const sendToTab = vi.fn(async () => ({ ok: true }))
    const updateTabUrl = vi.fn(async () => undefined)
    const queryActiveTab = vi.fn(async () => ({
      id: 7,
      url: 'https://example.com/page',
    }))

    const result = await handleBrowserToolMessage(
      {
        type: BROWSER_TOOL_MSG,
        tool: BROWSER_TOOL_NAVIGATE,
        url: 'https://example.com/page/details/1',
      },
      { injectContentScript, sendToTab, updateTabUrl, queryActiveTab },
    )

    expect(result).toEqual({ ok: true })
    expect(injectContentScript).toHaveBeenCalledWith(7)
    expect(sendToTab).toHaveBeenCalled()
    expect(updateTabUrl).not.toHaveBeenCalled()
  })

  it('uses tab update for cross-origin urls', async () => {
    const injectContentScript = vi.fn(async () => undefined)
    const sendToTab = vi.fn(async () => ({ ok: true }))
    const updateTabUrl = vi.fn(async () => undefined)
    const queryActiveTab = vi.fn(async () => ({
      id: 8,
      url: 'https://example.com/page',
    }))

    await handleBrowserToolMessage(
      {
        type: BROWSER_TOOL_MSG,
        tool: BROWSER_TOOL_NAVIGATE,
        url: 'https://other.example.com/page',
      },
      { injectContentScript, sendToTab, updateTabUrl, queryActiveTab },
    )

    expect(updateTabUrl).toHaveBeenCalledWith(8, 'https://other.example.com/page')
    expect(sendToTab).not.toHaveBeenCalled()
  })
})

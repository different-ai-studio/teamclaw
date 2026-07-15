import { describe, it, expect, vi } from 'vitest'
import { fetchActivePageContext } from './page-fetch'

describe('fetchActivePageContext', () => {
  it('sends request-page to the active tab and returns its page-context', async () => {
    const pc = { type: 'page-context', payload: { title: 'T', url: 'u', text: 'B', selection: '' } }
    const sendToTab = vi.fn().mockResolvedValue(pc)
    const out = await fetchActivePageContext({
      queryActiveTabId: async () => 7,
      sendToTab,
    })
    expect(sendToTab).toHaveBeenCalledWith(7, { type: 'request-page' })
    expect(out).toEqual(pc)
  })
  it('returns null when there is no active tab', async () => {
    const out = await fetchActivePageContext({
      queryActiveTabId: async () => null,
      sendToTab: vi.fn(),
    })
    expect(out).toBeNull()
  })
  it('returns null when the tab response is not a page-context', async () => {
    const out = await fetchActivePageContext({
      queryActiveTabId: async () => 1,
      sendToTab: async () => ({ type: 'nope' }),
    })
    expect(out).toBeNull()
  })
})

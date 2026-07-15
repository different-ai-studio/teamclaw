import { describe, it, expect } from 'vitest'
import { isRequestPage, isPageContext, isOpenSidePanel, pageContextMsg, openSidePanelMsg } from './messages'

describe('messages', () => {
  it('recognizes request-page', () => {
    expect(isRequestPage({ type: 'request-page' })).toBe(true)
    expect(isRequestPage({ type: 'other' })).toBe(false)
    expect(isRequestPage(null)).toBe(false)
  })
  it('recognizes open-side-panel', () => {
    const m = openSidePanelMsg({
      page: { title: 'T', url: 'https://x', text: 't', selection: 't' },
      linkKey: 'https://x',
      source: 'link-hover',
    })
    expect(isOpenSidePanel(m)).toBe(true)
    expect(isOpenSidePanel({ type: 'open-side-panel' })).toBe(false)
  })
  it('builds and recognizes page-context', () => {
    const m = pageContextMsg({ title: 'T', url: 'u', text: 'b', selection: '' })
    expect(m.type).toBe('page-context')
    expect(isPageContext(m)).toBe(true)
    expect(isPageContext({ type: 'page-context' })).toBe(false)
  })
})
